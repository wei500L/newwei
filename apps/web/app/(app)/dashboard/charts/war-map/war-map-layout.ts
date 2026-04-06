const WAR_MAP_DEFAULT_MIN_HEIGHT_CLASS = 'min-h-[24rem]';
const WAR_MAP_DEFAULT_HEIGHT_CLASS = 'h-[clamp(24rem,50dvh,29rem)]';

function hasMinHeightClass(className: string): boolean {
  return className
    .split(/\s+/)
    .map((token) => token.split(':').pop()?.replace(/^!/, '') ?? '')
    .some((token) => token.startsWith('min-h-'));
}

export function resolveWarMapContainerClassName(className?: string): string {
  const trimmed = className?.trim() ?? '';
  const classes = ['relative'];

  if (trimmed.length > 0) {
    if (!hasMinHeightClass(trimmed)) {
      classes.push(WAR_MAP_DEFAULT_MIN_HEIGHT_CLASS);
    }
    classes.push(trimmed);
  } else {
    classes.push(WAR_MAP_DEFAULT_MIN_HEIGHT_CLASS, WAR_MAP_DEFAULT_HEIGHT_CLASS);
  }

  return classes.join(' ');
}
