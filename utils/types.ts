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
