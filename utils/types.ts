import { createZenStackClient } from "../zenstack/utils.ts";

export type song = {
  id: string;
  title: string;
  artist: string;
  length: number;
  notes: string;
  properties: { [key: string]: any };
};

export type category = {
  id: string;
  title: string;
  show: boolean;
  type: string;
  valueRange: any[];
};

export type setSpot = {
  set: number;
  spotPrio: number;
  songId: string;
};

export type setlistTimeDTO = {
  fixedTime: "START" | "END";
  time: string;
  breakLen: number;
  breakBuffer: number;
};

export type db = ReturnType<typeof createZenStackClient>;
