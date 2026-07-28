import { signIn } from "@/app/auth/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-24">
        <h1 className="text-center text-2xl font-semibold text-black dark:text-zinc-50">
          Log in
        </h1>
        <form action={signIn} className="flex flex-col gap-4">
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-black dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="Password"
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-black dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            className="cursor-pointer rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Log in
          </button>
        </form>
        <p className="text-center text-sm text-zinc-500">
          Don&apos;t have an account?{" "}
          <a href="/signup" className="underline hover:text-zinc-800 dark:hover:text-zinc-200">
            Sign up
          </a>
        </p>
      </main>
    </div>
  );
}
