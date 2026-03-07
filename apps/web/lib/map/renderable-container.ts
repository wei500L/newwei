export interface RenderableContainerLike {
  clientWidth: number;
  clientHeight: number;
}

export function hasRenderableContainerSize(
  container: RenderableContainerLike | null | undefined,
): boolean {
  return Boolean(container && container.clientWidth > 0 && container.clientHeight > 0);
}
