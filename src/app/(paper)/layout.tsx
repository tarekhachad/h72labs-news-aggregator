import { Masthead } from "@/components/newspaper/Masthead";

/**
 * Shared shell for every newspaper page (front page, topic pages, dated
 * history pages) — hosts the masthead (title + sidebar hamburger). Page-
 * specific navigation (TopicBand on the front page, TopicNavBox on a topic
 * page) is rendered by each page itself, not here, since it differs per
 * route and a shared layout has no per-child slot for it.
 */
export default function PaperLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Masthead />
      {children}
    </div>
  );
}
