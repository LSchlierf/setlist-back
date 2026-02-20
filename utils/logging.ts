function timeStamp() {
  return `\x1b[34m[${new Date().toISOString()}]\x1b[0m`;
}

export function log(...data: any) {
  console.log(timeStamp(), ...data);
}
