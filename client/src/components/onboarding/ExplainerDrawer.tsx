/**
 * ─── ExplainerDrawer ────────────────────────────────────────────────────────
 *
 * Bottom-sheet body shared by every InfoChip. Renders the title, hero emoji,
 * body paragraph, and optional sub-sections for a given topic.
 *
 * Topic content lives in `copy.ts`. This component is purely presentational —
 * it doesn't track "seen" state itself (InfoChip does that).
 */

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { EXPLAINERS, type TopicKey } from "./copy";

interface ExplainerDrawerProps {
  topic: TopicKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExplainerDrawer({
  topic,
  open,
  onOpenChange,
}: ExplainerDrawerProps) {
  const content = EXPLAINERS[topic];
  if (!content) return null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          {content.emoji && (
            <div
              aria-hidden
              style={{
                fontSize: 40,
                lineHeight: 1,
                marginBottom: 4,
                color: "#00C896",
              }}
            >
              {content.emoji}
            </div>
          )}
          <DrawerTitle
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: "#1C1C1E",
            }}
          >
            {content.title}
          </DrawerTitle>
          <DrawerDescription
            style={{
              fontSize: 14,
              color: "#3C3C43",
              lineHeight: 1.5,
              marginTop: 4,
            }}
          >
            {content.body}
          </DrawerDescription>
        </DrawerHeader>

        {content.subSections && content.subSections.length > 0 && (
          <div
            style={{
              padding: "0 16px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {content.subSections.map(section => (
              <div
                key={section.label}
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "rgba(0, 200, 150, 0.06)",
                  border: "1px solid rgba(0, 200, 150, 0.18)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#00805E",
                    marginBottom: 2,
                  }}
                >
                  {section.label}
                </div>
                <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.45 }}>
                  {section.body}
                </div>
              </div>
            ))}
          </div>
        )}

        <DrawerFooter>
          <DrawerClose asChild>
            <Button
              style={{
                background: "#00C896",
                color: "white",
                fontWeight: 600,
                height: 44,
                borderRadius: 12,
              }}
            >
              Got it
            </Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
