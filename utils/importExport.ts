import { createZenStackClient } from "../zenstack/utils.ts";

interface song {
  id: string;
  title: string;
  artist: string;
  length: number;
  properties: Record<string, boolean | string | string[]>;
}

interface property {
  songId: string;
  categoryId: string;
  value: any;
}

export async function ingestRepertoire(
  db: ReturnType<typeof createZenStackClient>,
  bandId: string,
  repertoire: any
) {
  // delete old repertoire
  await db.category.deleteMany({
    where: {
      band: {
        id: bandId,
      },
    },
  });

  await db.song.deleteMany({
    where: {
      band: {
        id: bandId,
      },
    },
  });

  // songs

  await db.song.createMany({
    data: repertoire.songs.map((song: song) => ({
      id: song.id,
      title: song.title,
      artist: song.artist,
      length: song.length,
      bandId: bandId,
    })),
  });

  // prepare properties

  const allProperties: property[] = repertoire.songs.flatMap((song: song) =>
    Object.keys(song.properties).map((propKey) => ({
      songId: song.id,
      categoryId: propKey,
      value: song.properties[propKey],
    }))
  );

  const categoryToProperties = new Map<string, property[]>();

  for (const property of allProperties) {
    if (!categoryToProperties.has(property.categoryId)) {
      categoryToProperties.set(property.categoryId, []);
    }
    categoryToProperties.get(property.categoryId)!.push(property);
  }

  // categories

  for (const category of repertoire.categories) {
    const basicData = {
      id: category.id,
      title: category.title,
      show: category.show,
      bandId: bandId,
    };
    switch (category.type) {
      case "bool":
        await db.booleanCategory.create({
          data: {
            ...basicData,
            values: {
              create: category.valueRange.map((v: boolean) => ({
                value: v,
                properties: {
                  create:
                    categoryToProperties
                      .get(category.id)
                      ?.filter((p) => p.value === v)
                      .map((property) => ({
                        songId: property.songId,
                      })) || [],
                },
              })),
            },
          },
        });
        break;
      case "number":
        await db.numberCategory.create({
          data: {
            ...basicData,
            values: {
              create: category.valueRange.map((v: number) => ({
                value: v,
                properties: {
                  create:
                    categoryToProperties
                      .get(category.id)
                      ?.filter((p) => parseInt(p.value) === v)
                      .map((property) => ({
                        songId: property.songId,
                      })) || [],
                },
              })),
            },
          },
        });
        break;
      case "string":
        await db.stringCategory.create({
          data: {
            ...basicData,
            values: {
              create: category.valueRange.map((v: string) => ({
                value: v,
                properties: {
                  create:
                    categoryToProperties
                      .get(category.id)
                      ?.filter((p) => p.value === v)
                      .map((property) => ({
                        songId: property.songId,
                      })) || [],
                },
              })),
            },
          },
        });
        break;
      case "stringMultiple":
        await db.multipleStringCategory.create({
          data: {
            ...basicData,
            values: {
              create: category.valueRange.map((v: string) => ({
                value: v,
                properties: {
                  create:
                    categoryToProperties
                      .get(category.id)
                      ?.filter((p) => p.value.includes(v))
                      .map((property) => ({
                        songId: property.songId,
                      })) || [],
                },
              })),
            },
          },
        });
        break;
    }
  }
}

export async function ingestSetlist(
  db: ReturnType<typeof createZenStackClient>,
  bandId: string,
  setlist: any
) {
  await db.setlist.create({
    data: {
      band: {
        connect: {
          id: bandId,
        },
      },
      startTime: setlist.startTime,
      name: setlist.concert,
      fixedTime: setlist.timeFixed === "start" ? "START" : "END",
      breakLen: setlist.breaks?.len,
      breakBuffer: setlist.breaks?.buffer,
      setSpots: {
        create: [
          ...setlist.encore.map((song: { id: string }, songIndex: number) => ({
            songId: song.id,
            set: 0,
            spotPrio: songIndex,
          })),
          ...setlist.sets.flatMap((set: { id: string }[], setIndex: number) =>
            set.map((song: { id: string }, songIndex: number) => ({
              songId: song.id,
              set: setIndex + 1,
              spotPrio: songIndex,
            }))
          ),
        ],
      },
    },
  });
}
