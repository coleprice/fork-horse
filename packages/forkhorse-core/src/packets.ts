import type { Packet } from "./workflow-types";

/** Legacy packets remain active; normalize on read without rewriting history. */
export function publicPacket(packet: Omit<Packet, "archived"> & Partial<Pick<Packet, "archived">>): Packet {
  return { ...packet, archived: packet.archived ?? null };
}
