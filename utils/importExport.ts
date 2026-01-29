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

function convertMapToObject(input: Map<string, any>) {
  const obj: { [key: string]: any } = {};
  input.forEach((v, k) => {
    obj[k] = v;
  });
  return obj;
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

export async function egressSongs(
  db: ReturnType<typeof createZenStackClient>,
  bandId: string
) {
  const propertyQuery = {
    include: {
      value: {
        omit: {
          id: true,
        },
      },
    },
    omit: {
      songId: true,
      valueId: true,
    },
  };

  const songs = (
    await db.song.findMany({
      where: {
        bandId: bandId,
      },
      include: {
        booleanProperties: propertyQuery,
        numberProperties: propertyQuery,
        stringProperties: propertyQuery,
        multipleStringProperties: propertyQuery,
      },
      omit: {
        bandId: true,
      },
    })
  ).map((s) => ({
    ...s,
    booleanProperties: undefined,
    numberProperties: undefined,
    stringProperties: undefined,
    multipleStringProperties: undefined,
    properties: convertMapToObject(
      new Map(
        [
          ...s.booleanProperties,
          ...s.numberProperties,
          ...s.stringProperties,
          ...s.multipleStringProperties,
        ].map((p) => [p.value.categoryId, p.value.value])
      )
    ),
  }));

  return songs;
}

export async function egressCategories(
  db: ReturnType<typeof createZenStackClient>,
  bandId: string
) {
  const categoryQuery = {
    where: {
      bandId: bandId,
    },
    omit: {
      bandId: true,
    },
    include: {
      values: {
        omit: {
          categoryId: true,
          id: true,
        },
      },
    },
  };

  const categories = (
    await Promise.all([
      db.booleanCategory.findMany(categoryQuery),
      db.numberCategory.findMany(categoryQuery),
      db.stringCategory.findMany(categoryQuery),
      db.multipleStringCategory.findMany(categoryQuery),
    ])
  )
    .map((cs) =>
      cs.map((c) => ({
        ...c,
        values: undefined,
        valueRange: c.values.map((v) => v.value),
      }))
    )
    .flat();

  return categories;
}

export async function egressRepertoire(
  db: ReturnType<typeof createZenStackClient>,
  bandId: string
) {
  return {
    categories: await egressCategories(db, bandId),
    songs: await egressSongs(db, bandId),
  };
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
