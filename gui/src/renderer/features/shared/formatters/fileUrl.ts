export function buildLocalFileUrl(targetPath: string) {
  const normalized = targetPath.replace(/\\/g, "/");
  return encodeURI(`file:///${normalized}`);
}
