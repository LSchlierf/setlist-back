import { createZenStackClient } from "./zenstack/utils.ts";

import bodyparser from "body-parser";
import crypt from "crypto";
import express, { Router } from "express";
import fs from "fs";
import http from "http";
import https from "https";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import proxy from "express-http-proxy";

import dotenv from "dotenv";
import {
  egressCategories,
  egressRepertoire,
  egressSongs,
  ingestRepertoire,
  ingestSetlist,
} from "./utils/importExport.ts";
import { initSocket } from "./utils/socket.ts";
import { log } from "./utils/logging.ts";

dotenv.config();

let server: http.Server | https.Server;
let acmeServer: http.Server;

const db = createZenStackClient();
const app = express();
let acmePassThrough = express();

if (!process.env.DEV) {
  const privateKey = fs.readFileSync(
    "/etc/letsencrypt/live/setlist.lschlierf.de/privkey.pem",
    "utf-8"
  );
  const certificate = fs.readFileSync(
    "/etc/letsencrypt/live/setlist.lschlierf.de/fullchain.pem",
    "utf-8"
  );

  const credentials = {
    key: privateKey,
    cert: certificate,
  };

  server = https.createServer(credentials, app);
  acmeServer = http.createServer(acmePassThrough);
} else {
  server = http.createServer(app);
}

const io = new Server(server);

type authenticatedRequest = express.Request & { bandId?: string };

function generateToken(bandId: string) {
  return jwt.sign({ bandId: bandId }, process.env.KEY!, {
    expiresIn: "365d",
  });
}

function authenticateToken(
  req: authenticatedRequest,
  res: express.Response,
  next: () => void
): void {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    res.sendStatus(401);
    return;
  }

  try {
    const band = jwt.verify(token, process.env.KEY!);
    req.bandId = (band as jwt.JwtPayload).bandId;
    next();
  } catch {
    res.sendStatus(403);
  }
}

app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());

app.get("/ping", (req, res) => {
  res.send("pong");
});

/***
 * USER MANAGEMENT
 */

app.post("/api/signup", async (req, res) => {
  const password = req.body?.password;
  const username = req.body?.username?.toLowerCase();
  if (!password || !username) {
    res.status(400);
    res.json({ status: "error", error: "missing request body" });
    return;
  }
  const userExists = await db.band.exists({
    where: {
      name: username,
    },
  });
  if (userExists) {
    res.status(400);
    res.json({ status: "error", error: "user exists already" });
    return;
  }
  const salt = crypt.randomBytes(16).toString("hex");
  const hash = crypt
    .createHash("sha512")
    .update(password)
    .update(salt)
    .digest()
    .toString("hex");
  try {
    const band = await db.band.create({
      data: {
        name: username,
        passhash: hash,
        passsalt: salt,
      },
    });
    res.status(200);
    res.json(generateToken(band.id));
  } catch {
    res.status(500);
  }
});

app.post("/api/login", async (req, res) => {
  const password = req.body?.password;
  const username = req.body?.username?.toLowerCase();
  if (!password || !username) {
    res.status(400);
    return;
  }
  const band = await db.band.findFirst({
    where: {
      name: username,
    },
  });
  if (!band) {
    res.sendStatus(400);
    return;
  }
  const { passhash, passsalt } = band;
  const testHash = crypt
    .createHash("sha512")
    .update(password)
    .update(passsalt)
    .digest()
    .toString("hex");
  if (passhash !== testHash) {
    res.sendStatus(403);
    return;
  }
  res.status(200);
  res.json(generateToken(band.id));
});

const userRouter = Router();
userRouter.use(authenticateToken);

userRouter.get("/ping", async (req: authenticatedRequest, res) => {
  const band = await db.band.findFirst({
    where: {
      id: req.bandId,
    },
  });
  res.status(200);
  res.send({ id: req.bandId, name: band?.name });
});

userRouter.post("/changePassword", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId;

  if (!req.body || "testuser" === bandId) {
    return res.sendStatus(400);
  }

  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.sendStatus(400);
  }

  const band = await db.band.findFirst({
    where: {
      id: bandId,
    },
  });

  if (!band) {
    return res.sendStatus(400);
  }
  const { passhash, passsalt } = band;
  const testHash = crypt
    .createHash("sha512")
    .update(oldPassword)
    .update(passsalt)
    .digest()
    .toString("hex");
  if (passhash !== testHash) {
    res.sendStatus(403);
    return;
  }

  const newSalt = crypt.randomBytes(16).toString("hex");
  const newHash = crypt
    .createHash("sha512")
    .update(newPassword)
    .update(newSalt)
    .digest()
    .toString("hex");

  await db.band.update({
    where: {
      id: bandId,
    },
    data: {
      passhash: newHash,
      passsalt: newSalt,
    },
  });

  res.sendStatus(200);
});

/***
 * REPERTOIRE MANAGEMENT
 */

userRouter.get("/repertoire", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  res.status(200);
  res.json(await egressRepertoire(db, bandId));
});

userRouter.get(
  "/repertoire/categories",
  async (req: authenticatedRequest, res) => {
    const bandId = req.bandId!;

    res.status(200);
    res.json(await egressCategories(db, bandId));
  }
);

userRouter.get("/repertoire/size", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId;

  res.status(200);
  res.json(
    await db.song.count({
      where: {
        bandId: bandId,
        softDeleted: false,
      },
    })
  );
});

userRouter.get("/repertoire/songs", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  res.status(200);
  res.json(await egressSongs(db, bandId));
});

userRouter.post(
  "/repertoire/ingest",
  async (req: authenticatedRequest, res) => {
    const repertoire = req.body;
    const bandId = req.bandId!;

    try {
      await ingestRepertoire(db, bandId, repertoire);
      io.of("/main").to(bandId).emit("refresh");
      res.sendStatus(200);
    } catch (e) {
      log("Exception occured during ingest setlist:", e);
      res.sendStatus(500);
    }
  }
);

userRouter.get("/repertoire/export", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  res.status(200);
  res.json(await egressRepertoire(db, bandId));
});

/***
 * SETLIST MANAGEMENT
 */

userRouter.get("/setlists", async (req: authenticatedRequest, res) => {
  const setlists = await db.setlist.findMany({
    where: {
      AND: {
        deletedAt: null,
        band: {
          id: req.bandId,
        },
      },
    },
    omit: {
      bandId: true,
      breakBuffer: true,
      breakLen: true,
      fixedTime: true,
      time: true,
      deletedAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      setSpots: {
        distinct: "set",
        where: {
          set: {
            gte: 0,
          },
        },
      },
    },
  });

  res.status(200);
  res.json(
    setlists.map((s) => ({
      ...s,
      setSpots: undefined,
      sets: s.setSpots.length,
    }))
  );
});

userRouter.get("/setlist/:id", async (req: authenticatedRequest, res) => {
  const setlist = await db.setlist.findFirst({
    where: {
      AND: {
        deletedAt: null,
        id: req.params.id as string,
        band: {
          id: req.bandId,
        },
      },
    },
    include: {
      setSpots: {
        omit: {
          setlistId: true,
        },
      },
      categoryVisibilities: {
        omit: {
          setlistId: true,
        },
      },
    },
    omit: {
      bandId: true,
      deletedAt: true,
    },
  });

  res.status(200);
  res.json(setlist);
});

userRouter.post("/setlist/ingest", async (req: authenticatedRequest, res) => {
  const setlist = req.body;
  const bandId = req.bandId!;

  try {
    await ingestSetlist(db, bandId, setlist);
    io.of("/main").to(bandId).emit("refresh");
    res.sendStatus(200);
  } catch (e) {
    log("Exception occured during ingest setlist:", e);
    res.sendStatus(500);
  }
});

userRouter.get(
  "/setlist/export/:id",
  async (req: authenticatedRequest, res) => {
    const bandId = req.bandId;
    const setlistId = req.params.id as string;

    res.sendStatus(501); // TODO maybe, currently JSON dump of /setlist/:id
  }
);

userRouter.post("/setlist/create", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  const id = (
    await db.setlist.create({
      data: {
        band: {
          connect: {
            id: bandId,
          },
        },
        createdAt: new Date(),
      },
      omit: {
        bandId: true,
        breakBuffer: true,
        breakLen: true,
        fixedTime: true,
        name: true,
        time: true,
      },
    })
  ).id;

  io.of("/main").to(bandId).emit("refresh");
  res.status(200);
  res.json(id);
});

userRouter.delete("/setlist/:id", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;
  const setlistId = req.params.id as string;

  try {
    await db.setlist.update({
      data: {
        deletedAt: new Date(),
      },
      where: {
        id: setlistId,
        AND: {
          bandId: bandId,
          deletedAt: null,
        },
      },
    });

    io.of("/main").to(bandId).emit("refresh");
    res.sendStatus(200);
  } catch (e) {
    log("Error during delete setllist:", e);
    res.sendStatus(500);
  }
});

app.use("/api/user", userRouter);

/***
 * WebSocket fucnctionality
 */

initSocket(io, db);

acmePassThrough.use(express.static("/acme", { dotfiles: "allow" }));

app.use("/", proxy("localhost:3000/"));

const PORT = process.env.DEV ? 8080 : 443;

server.listen(PORT, () => {
  log(`server listening on port ${PORT}`);
  if (process.env.DEV) {
    log(`http://localhost:${PORT}`);
  } else {
    acmeServer.listen(80);
  }
  db.band.count().then((c) => {
    log(`${c} users loaded in db`);
  });
});
