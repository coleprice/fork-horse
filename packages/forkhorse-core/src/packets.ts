import type { Packet } from "./workflow-types";
import { publicPacket as racePacket } from "./race-entrants";

/** Legacy packets remain active; normalize on read without rewriting history. */
export function publicPacket(packet: Omit<Packet, "archived"> & Partial<Pick<Packet, "archived">>): Packet {
  return racePacket({ ...packet, archived: packet.archived ?? null });
}
