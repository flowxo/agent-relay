import { sha256 } from "@agent-relay/protocol";
import {
  CardActionKindSchema,
  CardActionTokenSchema,
  type CardActionKind,
} from "@agent-relay/notification-contracts";

export { CardActionKindSchema, CardActionTokenSchema, type CardActionKind };

export function cardActionToken(
  eventId: string,
  action: CardActionKind,
): string {
  return CardActionTokenSchema.parse(
    `card_${sha256(`${eventId}\u001f${action}`).slice(0, 32)}`,
  );
}
