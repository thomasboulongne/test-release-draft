export function initUploadPipeline(chunkSize: number) {
  return { chunkSize, parallel: 4, retries: 3 };
}
