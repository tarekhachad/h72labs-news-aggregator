import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { addBookmark, removeBookmark } from "@/lib/bookmarks";

const BookmarkInput = z.object({ cardId: z.string().uuid() });

async function parseCardId(req: Request): Promise<{ cardId: string } | { error: string }> {
  const body = await req.json().catch(() => null);
  const parsed = BookmarkInput.safeParse(body);
  if (!parsed.success) return { error: "Invalid request" };
  return { cardId: parsed.data.cardId };
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const parsed = await parseCardId(req);
  if ("error" in parsed) return new Response(parsed.error, { status: 400 });

  const { error } = await addBookmark(supabase, user.id, parsed.cardId);
  if (error) return new Response(error, { status: 400 });

  return new Response(null, { status: 204 });
}

export async function DELETE(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const parsed = await parseCardId(req);
  if ("error" in parsed) return new Response(parsed.error, { status: 400 });

  const { error } = await removeBookmark(supabase, user.id, parsed.cardId);
  if (error) return new Response(error, { status: 400 });

  return new Response(null, { status: 204 });
}
