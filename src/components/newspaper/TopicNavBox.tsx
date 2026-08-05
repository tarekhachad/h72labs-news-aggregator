"use client";

import Link from "next/link";
import { ChevronDown, Newspaper } from "lucide-react";
import type { Topic } from "@/types";
import { topicToSlug } from "@/lib/topicSlug";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Topic page's top-right dropdown — lists every topic plus "Front Page,"
 * per docs/(C) UI_DESIGN.md's Topic navigation controls. Selecting an entry
 * is plain navigation in B5; B8 intercepts it to trigger the page-flip
 * (flipping through intervening pages for a multi-page jump) instead.
 */
export function TopicNavBox({
  topics,
  activeTopic,
  basePath = "",
}: {
  topics: Topic[];
  activeTopic: Topic;
  /**
   * "" for the live/today pages (front page "/", topic "/topic/[slug]");
   * "/history/2026-08-01" when browsing a past date, so "Front Page" and
   * the topic links stay scoped to that date instead of jumping to today.
   */
  basePath?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" className="cursor-pointer gap-2">
            {activeTopic}
            <ChevronDown className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          render={
            <Link href={basePath || "/"} className="flex items-center gap-2">
              <Newspaper className="size-4" /> Front Page
            </Link>
          }
        />
        <DropdownMenuSeparator />
        {topics.map((topic) => (
          <DropdownMenuItem
            key={topic}
            disabled={topic === activeTopic}
            render={<Link href={`${basePath}/topic/${topicToSlug(topic)}`}>{topic}</Link>}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
