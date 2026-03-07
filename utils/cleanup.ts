import { ingestRepertoire, ingestSetlist } from "./importExport.ts";
import { log } from "./logging.ts";
import { testuserRepertoire, testUserSetlist1, testUserSetlist2 } from "./testuserData.ts";
import { type db } from "./types.ts";

export async function bandCleanup(bandId: string, db: db) {
  await deletedSongCleanup(bandId, db);
  await deletedCategoryCleanup(bandId, db);
  await spotPrioCleanup(bandId, db);
  if ("testuser" === bandId) {
    await testuserCleanup(db);
  }
}

async function spotPrioCleanup(bandId: string, db: db) {
  const rows = await db.$executeRaw`
  with newPrio as (
    select "setlistId", "songId", rank() over (partition by "setlistId", set order by "spotPrio" asc ) - 1 as prio from "setSpot"
  )
  update "setSpot" o
  set "spotPrio" = (
    select prio
    from newPrio n
    where n."setlistId" = o."setlistId" and n."songId" = o."songId"
  )
  where o."spotPrio" <> (
    select prio
    from newPrio n
    where n."setlistId" = o."setlistId" and n."songId" = o."songId"
  ) 
  and o."setlistId" in (
    select "id" from setlist where "bandId" = ${bandId}
  );
  `;
  log("cleaned up", rows, "setSpots");
}

async function deletedSongCleanup(bandId: string, db: db) {
  const rows = await db.song.deleteMany({
    where: {
      bandId: bandId,
      softDeleted: true,
    },
  });
  log("permanently deleted", rows.count, "soft deleted songs");
}

async function deletedCategoryCleanup(bandId: string, db: db) {
  const rows = await db.category.deleteMany({
    where: {
      bandId: bandId,
      softDeleted: true,
    },
  });
  log("permanently deleted", rows.count, "soft deleted categories");
}

async function testuserCleanup(db: db) {
  await db.$transaction(async (tx) => {
    await tx.song.deleteMany({
      where: {
        bandId: "testuser",
      },
    });
    await tx.category.deleteMany({
      where: {
        bandId: "testuser",
      },
    });
    await tx.setlist.deleteMany({
      where: {
        bandId: "testuser",
      },
    });
    await ingestRepertoire(tx, "testuser", testuserRepertoire);
    await ingestSetlist(tx, "testuser", testUserSetlist1);
    await ingestSetlist(tx, "testuser", testUserSetlist2);
  });
  log("reset test user");
}
