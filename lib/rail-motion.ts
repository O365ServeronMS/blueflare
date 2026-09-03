export type RailDirection = -1 | 1;

const RAIL_PAGE_FRACTION = 0.82;
const POSITION_EPSILON = 1;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function getRailSlideTarget({
  origin,
  direction,
  viewportWidth,
  maxScrollLeft,
  snapPoints
}: {
  origin: number;
  direction: RailDirection;
  viewportWidth: number;
  maxScrollLeft: number;
  snapPoints: number[];
}) {
  const maximum = Math.max(0, maxScrollLeft);
  const current = clamp(origin, 0, maximum);
  if (!maximum || !viewportWidth) return current;

  const points = [...new Set([0, maximum, ...snapPoints]
    .map((point) => clamp(point, 0, maximum)))]
    .sort((left, right) => left - right);
  const desired = clamp(current + direction * viewportWidth * RAIL_PAGE_FRACTION, 0, maximum);

  let target = points[0];
  let targetDistance = Math.abs(target - desired);
  for (const point of points.slice(1)) {
    const distance = Math.abs(point - desired);
    const winsTie = distance === targetDistance
      && (direction === 1 ? point > target : point < target);
    if (distance < targetDistance || winsTie) {
      target = point;
      targetDistance = distance;
    }
  }

  if (Math.abs(target - current) <= POSITION_EPSILON) {
    let nextPoint: number | undefined;
    if (direction === 1) {
      nextPoint = points.find((point) => point > current + POSITION_EPSILON);
    } else {
      for (let index = points.length - 1; index >= 0; index -= 1) {
        if (points[index] < current - POSITION_EPSILON) {
          nextPoint = points[index];
          break;
        }
      }
    }
    if (nextPoint !== undefined) return nextPoint;
  }

  return target;
}
