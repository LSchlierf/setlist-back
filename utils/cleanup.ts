import { log } from "./logging.ts";
import { type db } from "./types.ts";

export async function bandCleanup(bandId: string, db: db) {
  await spotPrioCleanup(bandId, db);
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
