import { z } from "zod";

export const CardActionKindSchema = z.enum([
  "continue",
  "details",
  "mute",
  "end",
]);

export type CardActionKind = z.infer<typeof CardActionKindSchema>;

export const CardActionTokenSchema = z.string().regex(/^card_[a-f0-9]{32}$/);
