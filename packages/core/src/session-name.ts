/**
 * Shared human-friendly session names for every operator surface.
 *
 * The name is a pure function of the already-opaque public session key. It
 * never incorporates a path, harness session ID, machine ID, or any other
 * private identifier, and it is stable across daemon restarts.
 *
 * Collision space: 64 adjectives × 64 nouns × 100 numbers = 409,600 names.
 * Collisions are possible; surfaces that need exact correlation keep the
 * opaque 24-hex session key available beside the readable name. Telegram
 * topic titles keep harness · repository · branch as a prefix, so a full
 * title collision also requires that prefix to match.
 */

export const SESSION_NAME_ADJECTIVES = [
  "amber",
  "bright",
  "brisk",
  "calm",
  "clear",
  "clever",
  "coastal",
  "copper",
  "crisp",
  "curious",
  "daring",
  "dawn",
  "deft",
  "dusty",
  "eager",
  "early",
  "easy",
  "fair",
  "fleet",
  "fond",
  "frosty",
  "gentle",
  "glad",
  "golden",
  "grand",
  "green",
  "hardy",
  "hazel",
  "humble",
  "ivory",
  "jolly",
  "keen",
  "kind",
  "level",
  "lively",
  "lucid",
  "lunar",
  "mellow",
  "merry",
  "mild",
  "misty",
  "neat",
  "nimble",
  "noble",
  "olive",
  "patient",
  "plain",
  "prime",
  "quiet",
  "rapid",
  "ready",
  "rustic",
  "sage",
  "sandy",
  "sharp",
  "silver",
  "smooth",
  "solar",
  "spry",
  "steady",
  "sunny",
  "tidy",
  "vivid",
  "warm",
] as const;

export const SESSION_NAME_NOUNS = [
  "acorn",
  "alder",
  "anchor",
  "arbor",
  "aspen",
  "badger",
  "basin",
  "beacon",
  "birch",
  "bluff",
  "bramble",
  "breeze",
  "brook",
  "canyon",
  "cedar",
  "cobble",
  "compass",
  "coral",
  "cove",
  "crane",
  "delta",
  "dune",
  "elder",
  "ember",
  "fjord",
  "forest",
  "fossil",
  "garnet",
  "glade",
  "grove",
  "harbor",
  "heron",
  "hollow",
  "island",
  "juniper",
  "kestrel",
  "lantern",
  "ledge",
  "lichen",
  "maple",
  "meadow",
  "mesa",
  "moss",
  "otter",
  "pebble",
  "pine",
  "prairie",
  "quarry",
  "reef",
  "ridge",
  "river",
  "sequoia",
  "shale",
  "shore",
  "sparrow",
  "spruce",
  "summit",
  "thicket",
  "thistle",
  "trail",
  "tundra",
  "valley",
  "willow",
  "wren",
] as const;

export const SESSION_NAME_COLLISION_SPACE =
  SESSION_NAME_ADJECTIVES.length * SESSION_NAME_NOUNS.length * 100;

function keySlice(sessionKey: string, start: number, length: number): number {
  const value = Number.parseInt(sessionKey.slice(start, start + length), 16);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Safe, stable, readable session name derived only from the opaque public key.
 */
export function sessionName(sessionKey: string): string {
  const adjective =
    SESSION_NAME_ADJECTIVES[
      keySlice(sessionKey, 0, 4) % SESSION_NAME_ADJECTIVES.length
    ]!;
  const noun =
    SESSION_NAME_NOUNS[keySlice(sessionKey, 4, 4) % SESSION_NAME_NOUNS.length]!;
  const number = String(keySlice(sessionKey, 8, 4) % 100).padStart(2, "0");
  return `${adjective}-${noun}-${number}`;
}
