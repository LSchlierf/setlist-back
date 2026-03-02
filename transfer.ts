import pg_p from "pg-promise";
import dotenv from "dotenv";
import { log } from "./utils/logging.ts";
import { createZenStackClient } from "./zenstack/utils.ts";
import { type TransactionClientContract } from "@zenstackhq/orm";
import { type SchemaType } from "./zenstack/schema.ts";
import { ingestRepertoire, ingestSetlist } from "./utils/importExport.ts";

dotenv.config();

const pgp = pg_p();

if (process.env.DBURLOLD === undefined || process.env.DBURL === undefined) {
  log("Mising env variables");
  process.exit(1);
}

const db_old = pgp(process.env.DBURLOLD);
const db_new = createZenStackClient();

type t = TransactionClientContract<SchemaType, any, {}, {}>;

async function transferUsers(tx: t) {
  const users_old = (await db_old.many("SELECT * FROM public.users")).filter(
    (u) => u.id === 5 || u.id === 4
  );
  let ids = new Map<number, string>();
  let names = new Map<number, string>();
  await Promise.all(
    users_old.map(async (u) => {
      const newUser = await tx.band.create({
        data: {
          name: u.username,
          passhash: u.passhash,
          passsalt: u.passsalt,
        },
      });
      ids.set(u.id, newUser.id);
      names.set(u.id, u.username);
    })
  );
  log("Transfered Users");
  log(ids);
  log(names);
  return ids;
}

async function transferRepertoires(tx: t, ids: Map<number, string>) {
  const users_old = await db_old.many(
    "SELECT * FROM public.users WHERE id IN ($1:list)",
    [ids.keys().toArray()]
  );
  await Promise.all(
    users_old.map(async (u) => {
      await ingestRepertoire(tx, ids.get(u.id), u.repertoire);
    })
  );
  log("Transfered Repertoires");
}

async function transferBandSetlists(tx: t, id_old: number, id_new: string) {
  const setlists_old = await db_old.many(
    "SELECT * FROM public.setlists WHERE userid = $1",
    [id_old]
  );
  await Promise.all(
    setlists_old.map(async (s) => ingestSetlist(tx, id_new, s.data))
  );
  log("Transfered", setlists_old.length, "Setlists for", id_old, id_new);
}

async function transferSetists(tx: t, ids: Map<number, string>) {
  await Promise.all(
    ids
      .entries()
      .map(async ([id_old, id_new]) => transferBandSetlists(tx, id_old, id_new))
  );
  log("Transferred setlists");
}

async function main() {
  await db_new.$transaction(async (tx) => {
    await tx.band.deleteMany();
    const ids = await transferUsers(tx);
    await transferRepertoires(tx, ids);
    await transferSetists(tx, ids);
    // throw new Error(); // abort transaction
  });
}

main().then(() => {
  log("finished.");
  process.exit(0);
});
