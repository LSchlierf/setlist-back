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

dotenv.config();

let server: http.Server | https.Server;
let io: Server;

const db = createZenStackClient();
const app = express();

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
  io = new Server(server);
} else {
  server = http.createServer(app);
  io = new Server(server);
}

type authenticatedRequest = express.Request & { bandId?: string };

type song = {
  id: string;
  title: string;
  artist: string;
  length: number;
  notes: string;
  properties: { [key: string]: any };
};

type category = {
  id: string;
  title: string;
  show: boolean;
  type: string;
  valueRange: any[];
};

function generateToken(bandId: string) {
  return jwt.sign({ bandId: bandId }, process.env.KEY!, {
    expiresIn: "365d",
  });
}

function validateToken(token: string) {
  return jwt.verify(token, process.env.KEY!) as jwt.JwtPayload;
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

  if (!req.body) {
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

userRouter.get("/repertoire/songs", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  res.status(200);
  res.json(await egressSongs(db, bandId));
});

userRouter.get("/repertoire/size", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId;

  res.status(200);
  res.json(
    await db.song.count({
      where: {
        bandId: bandId,
      },
    })
  );
});

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
      startTime: true,
      deletedAt: true,
    },
    include: {
      setSpots: {
        distinct: "set",
        where: {
          set: {
            not: 0,
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
    },
  });

  res.status(200);
  res.json(setlist);
});

userRouter.post(
  "/repertoire/ingest",
  async (req: authenticatedRequest, res) => {
    const repertoire = req.body;
    const bandId = req.bandId!;

    try {
      await ingestRepertoire(db, bandId, repertoire);
      res.sendStatus(200);
    } catch (e) {
      console.log("Exception occured during ingest setlist:", e);
      res.sendStatus(500);
    }
  }
);

userRouter.post("/setlist/ingest", async (req: authenticatedRequest, res) => {
  const setlist = req.body;
  const bandId = req.bandId!;

  try {
    await ingestSetlist(db, bandId, setlist);
    res.sendStatus(200);
  } catch (e) {
    console.log("Exception occured during ingest setlist:", e);
    res.sendStatus(500);
  }
});

userRouter.get(
  "/setlist/export/:id",
  async (req: authenticatedRequest, res) => {
    const bandId = req.bandId;
    const setlistId = req.params.id as string;

    res.sendStatus(501); // TODO
  }
);

userRouter.get("/repertoire/export", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId!;

  res.status(200);
  res.json(await egressRepertoire(db, bandId));
});

userRouter.post("/setlist/create", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId;

  const id = (
    await db.setlist.create({
      data: {
        band: {
          connect: {
            id: bandId,
          },
        },
      },
      omit: {
        bandId: true,
        breakBuffer: true,
        breakLen: true,
        fixedTime: true,
        name: true,
        startTime: true,
      },
    })
  ).id;

  res.status(200);
  res.json(id);
});

userRouter.delete("/setlist/:id", async (req: authenticatedRequest, res) => {
  const bandId = req.bandId;
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

    res.sendStatus(200);
  } catch (e) {
    console.log("Error during delete setllist:", e);
    res.sendStatus(500);
  }
});

app.use("/api/user", userRouter);

io.on("connection", (socket) => {
  const token = socket.handshake.headers?.token as string;
  if (!token) return;
  let payload;
  try {
    payload = validateToken(token);
  } catch {
    return;
  }
  const bandId = payload.bandId;

  console.log("band connect:", bandId);

  socket.join(bandId);

  socket.on("repertoire", () => {
    socket.to(bandId).emit("repertoire");
  });

  socket.on("repertoire:addSong", async (newSong: song) => {
    try {
      const data = {
        ...newSong,
        properties: undefined,
      };

      await db.song.create({
        data: {
          ...data,
          band: {
            connect: {
              id: bandId,
            },
          },
        },
      });

      socket.to(bandId).emit("repertoire:addSong", newSong);
    } catch {
      socket.to(bandId).emit("repertoire");
    }
  });

  socket.on("repertoire:updateSong", async (newSong: song) => {
    try {
      const data = {
        ...newSong,
        properties: undefined,
      };

      const categories = await db.category.findMany({
        where: {
          bandId: bandId,
        },
        omit: {
          bandId: true,
          title: true,
          show: true,
        },
      });

      await db.song.update({
        where: {
          id: newSong.id,
          bandId: bandId,
        },
        data: {
          ...data,
          booleanProperties: {
            deleteMany: {
              songId: newSong.id,
            },
          },
          numberProperties: {
            deleteMany: {
              songId: newSong.id,
            },
          },
          stringProperties: {
            deleteMany: {
              songId: newSong.id,
            },
          },
          multipleStringProperties: {
            deleteMany: {
              songId: newSong.id,
            },
          },
        },
      });

      const getRelevantCategories = (
        categoryType:
          | "booleanCategory"
          | "numberCategory"
          | "stringCategory"
          | "multipleStringCategory",
        song: song
      ) =>
        categories
          .filter((c) => c.type === categoryType)
          .filter((c) => song.properties[c.id] !== undefined);

      await db.song.update({
        where: {
          id: newSong.id,
          bandId: bandId,
        },
        data: {
          booleanProperties: {
            create: getRelevantCategories("booleanCategory", newSong).map(
              (c) => ({
                value: {
                  connect: {
                    categoryId_value: {
                      categoryId: c.id,
                      value: newSong.properties[c.id] as boolean,
                    },
                  },
                },
              })
            ),
          },
          numberProperties: {
            create: getRelevantCategories("numberCategory", newSong).map(
              (c) => ({
                value: {
                  connect: {
                    categoryId_value: {
                      categoryId: c.id,
                      value: newSong.properties[c.id] as number,
                    },
                  },
                },
              })
            ),
          },
          stringProperties: {
            create: getRelevantCategories("stringCategory", newSong).map(
              (c) => ({
                value: {
                  connect: {
                    categoryId_value: {
                      categoryId: c.id,
                      value: newSong.properties[c.id] as string,
                    },
                  },
                },
              })
            ),
          },
          multipleStringProperties: {
            create: getRelevantCategories("multipleStringCategory", newSong)
              .flatMap((c) =>
                newSong.properties[c.id].map((v: string) => ({
                  categoryId: c.id,
                  value: v,
                }))
              )
              .map((property: { categoryId: string; value: string }) => ({
                value: {
                  connect: {
                    categoryId_value: property,
                  },
                },
              })),
          },
        },
      });

      socket.to(bandId).emit("repertoire:updateSong", newSong);
    } catch {
      socket.to(bandId).emit("repertoire");
    }
  });

  socket.on("repertoire:deleteSong", async (deletedSongId) => {
    try {
      await db.song.delete({
        where: {
          id: deletedSongId,
          bandId: bandId,
        },
      });
      socket.to(bandId).emit("repertoire:deleteSong", deletedSongId);
    } catch {
      socket.to(bandId).emit("repertoire");
    }
  });

  socket.on("repertoire:updateCategory", async (newCategory: category) => {
    try {
      await db.category.update({
        where: {
          id: newCategory.id,
          bandId: bandId,
        },
        data: {
          title: newCategory.title,
          show: newCategory.show,
        },
      });

      socket.to(bandId).emit("repertoire:updateCategory", newCategory);
    } catch {
      socket.to(bandId).emit("repertoire");
    }
  });

  socket.on("repertoire:deleteCategory", async (deletedCategoryId: string) => {
    try {
      await db.category.delete({
        where: {
          id: deletedCategoryId,
          bandId: bandId,
        },
      });
      socket.to(bandId).emit("repertoire:deleteCategory", deletedCategoryId);
    } catch {
      socket.to(bandId).emit("repertoire");
    }
  });

  socket.on("disconnect", () => {
    console.log("band disconnect");
  });
});

app.use(express.static("/acme", { dotfiles: "allow" }));

app.use("/", proxy("localhost:3000/"));

const PORT = process.env.DEV ? 8080 : 443;

server.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
  if (process.env.DEV) console.log(`http://localhost:${PORT}`);
  db.band.count().then((c) => {
    console.log(`${c} users loaded in db`);
  });
});
