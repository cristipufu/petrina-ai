/** Local service metadata only. Running and stopping validation workloads have separate native owners. */
export interface ContainerInspection {
  contextEndpoint(): Promise<string | undefined>;
  service(endpoint: string): Promise<{ os?: string; name?: string; version?: string }>;
  image(endpoint: string, image: string): Promise<{ id?: string; os?: string; architecture?: string } | undefined>;
}

/** Decode the native protocol once for both the CLI adapter and explicit private fixture observations. */
export function containerContextEndpoint(text: string): string | undefined {
  return JSON.parse(text)[0]?.Endpoints?.docker?.Host;
}
export function containerServiceInfo(text: string): Awaited<ReturnType<ContainerInspection["service"]>> {
  const info = JSON.parse(text);
  return { os: info.OSType, name: info.Name, version: info.ServerVersion };
}
export function containerImageInfo(text: string): Awaited<ReturnType<ContainerInspection["image"]>> {
  const image = JSON.parse(text)[0];
  return image && { id: image.Id, os: image.Os, architecture: image.Architecture };
}
