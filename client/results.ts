import type { Player } from "./protocol.ts";

export function roundWinners<T extends Pick<Player, "kills" | "forfeited">>(
  players: readonly T[],
): T[] {
  const contenders = players.filter((player) => !player.forfeited);
  const best = Math.max(-1, ...contenders.map((player) => player.kills));
  return contenders.filter((player) => player.kills === best);
}
