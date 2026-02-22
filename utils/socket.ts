import { Server } from "socket.io";
import { createZenStackClient } from "../zenstack/utils.ts";
import jwt from "jsonwebtoken";
import { type setSpot, type category, type song } from "./types.ts";
import { ingestSingleCategory } from "./importExport.ts";
import { log } from "./logging.ts";

function validateToken(token: string) {
  return jwt.verify(token, process.env.KEY!) as jwt.JwtPayload;
}

export function initSocket(
  io: Server,
  db: ReturnType<typeof createZenStackClient>
) {
  const repertoireSocket = io.of("/repertoire");
  const setlistSocket = io.of("/setlist");

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

    log("band connect:", bandId);

    socket.join(bandId);

    socket.on("disconnect", () => {
      log("band disconnect:", bandId);
    });
  });

  repertoireSocket.on("connection", (socket) => {
    const token = socket.handshake.headers?.token as string;
    if (!token) return;
    let payload;
    try {
      payload = validateToken(token);
    } catch {
      return;
    }
    const bandId = payload.bandId;

    log("band connect (repertoire):", bandId);

    socket.join(bandId);

    socket.on("repertoire", () => {
      repertoireSocket.to(bandId).emit("repertoire");
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

        repertoireSocket.to(bandId).emit("repertoire:addSong", newSong);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
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

        repertoireSocket.to(bandId).emit("repertoire:updateSong", newSong);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
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
        repertoireSocket
          .to(bandId)
          .emit("repertoire:deleteSong", deletedSongId);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
      }
    });

    socket.on("repertoire:addCategory", async (newCategory: category) => {
      try {
        await ingestSingleCategory(db, bandId, newCategory);
        repertoireSocket.to(bandId).emit("repertoire:addCategory", newCategory);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
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

        repertoireSocket
          .to(bandId)
          .emit("repertoire:updateCategory", newCategory);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
      }
    });

    socket.on(
      "repertoire:deleteCategory",
      async (deletedCategoryId: string) => {
        try {
          await db.category.delete({
            where: {
              id: deletedCategoryId,
              bandId: bandId,
            },
          });
          repertoireSocket
            .to(bandId)
            .emit("repertoire:deleteCategory", deletedCategoryId);
        } catch {
          repertoireSocket.to(bandId).emit("repertoire");
        }
      }
    );

    socket.on(
      "repertoire:setColors",
      async ({
        categoryId,
        colors,
      }: {
        categoryId: string;
        colors: { [key: string]: string };
      }) => {
        try {
          const category = await db.category.findFirst({
            where: {
              id: categoryId,
              bandId: bandId,
            },
            omit: {
              bandId: true,
              id: true,
              show: true,
              title: true,
            },
          });

          switch (category?.type) {
            case "booleanCategory":
              await db.booleanCategory.update({
                where: {
                  id: categoryId,
                },
                data: {
                  values: {
                    update: Object.keys(colors).map((v) => ({
                      where: {
                        categoryId_value: {
                          categoryId: categoryId,
                          value: v === "true",
                        },
                      },
                      data: {
                        colorHex: colors[v],
                      },
                    })),
                  },
                },
              });
              break;
            case "numberCategory":
              await db.numberCategory.update({
                where: {
                  id: categoryId,
                },
                data: {
                  values: {
                    update: Object.keys(colors).map((v) => ({
                      where: {
                        categoryId_value: {
                          categoryId: categoryId,
                          value: parseInt(v),
                        },
                      },
                      data: {
                        colorHex: colors[v],
                      },
                    })),
                  },
                },
              });
              break;
            case "stringCategory":
              await db.stringCategory.update({
                where: {
                  id: categoryId,
                },
                data: {
                  values: {
                    update: Object.keys(colors).map((v) => ({
                      where: {
                        categoryId_value: {
                          categoryId: categoryId,
                          value: v,
                        },
                      },
                      data: {
                        colorHex: colors[v],
                      },
                    })),
                  },
                },
              });
              break;
          }

          repertoireSocket
            .to(bandId)
            .emit("repertoire:setColors", { categoryId, colors });
        } catch {
          repertoireSocket.to(bandId).emit("repertoire");
        }
      }
    );

    socket.on("repertoire:deleteColors", async (categoryId: string) => {
      try {
        const category = await db.category.findFirst({
          where: {
            id: categoryId,
            bandId: bandId,
          },
          omit: {
            bandId: true,
            id: true,
            show: true,
            title: true,
          },
        });

        const query = {
          where: {
            categoryId: categoryId,
          },
          data: {
            colorHex: null,
          },
        };

        switch (category?.type) {
          case "booleanCategory":
            await db.booleanCategoryValue.updateMany(query);
            break;
          case "numberCategory":
            await db.numberCategoryValue.updateMany(query);
            break;
          case "stringCategory":
            await db.stringCategoryValue.updateMany(query);
            break;
        }

        repertoireSocket.to(bandId).emit("repertoire:deleteColors", categoryId);
      } catch {
        repertoireSocket.to(bandId).emit("repertoire");
      }
    });

    socket.on("disconnect", () => {
      log("band disconnect (repertoire):", bandId);
    });
  });

  setlistSocket.on("connection", (socket) => {
    const token = socket.handshake.headers?.token as string;
    const setlistId = socket.handshake.headers?.setlistid as string;
    if (!token || !setlistId) return;
    let payload;
    try {
      payload = validateToken(token);
    } catch {
      return;
    }
    const bandId = payload.bandId;
    const roomId = `${bandId} | ${setlistId}`;

    log("band connect (setlist):", roomId);

    socket.join(roomId);

    socket.on("setlist:updateName", async (newName: string) => {
      await db.setlist.update({
        where: {
          id: setlistId,
          bandId: bandId,
        },
        data: {
          name: newName,
        },
      });

      setlistSocket.to(roomId).emit("setlist:updateName", newName);
    });

    socket.on("setlist:createSpot", async (newSpot: setSpot) => {
      await db.setSpot.create({
        data: {
          setlistId: setlistId,
          ...newSpot,
        },
      });

      setlistSocket.to(roomId).emit("setlist:createSpot", newSpot);
    });

    socket.on("setlist:updateSpot", async (newSpot: setSpot) => {
      await db.setSpot.update({
        where: {
          songId_setlistId: {
            setlistId: setlistId,
            songId: newSpot.songId,
          },
        },
        data: newSpot,
      });
      setlistSocket.to(roomId).emit("setlist:updateSpot", newSpot);
    });

    socket.on("setlist:removeSpot", async (songId: string) => {
      await db.setSpot.delete({
        where: {
          songId_setlistId: {
            setlistId: setlistId,
            songId: songId,
          },
        },
      });
      setlistSocket.to(roomId).emit("setlist:removeSpot", songId);
    });

    socket.on("disconnect", () => {
      log("band disconnect (setlist):", roomId);
    });
  });
}
