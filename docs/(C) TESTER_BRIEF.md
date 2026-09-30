# Your Daily Brief: a guide for early testers

Tarek Hachad · H72 Labs · updated 2026-09-30

Thanks for trying this. You're one of the first handful of people I've let in, and it's still invite-only while I find out what works for people other than me. This page covers what the app is, how I expect it to be used, what's already on my list, and the feedback that would help me most. It takes about five minutes to read, and it should save you from telling me things I already know.

What you're getting is a working product running on real news every day. It has rough edges, and you'll probably hit one or two.

## What it is

The Personalized News Aggregator (the app itself calls it *Your Daily Brief*) is a daily news briefing at [news.h72labs.com](https://news.h72labs.com). You tell it which topics you follow and which news outlets you trust. Then you press one button, **Give me today's news**, and about a minute later you get a newspaper-style front page built from what those outlets published.

Each card on that page is one specific story, like a particular election result or a particular transfer, and not a broad bucket like "politics." When several of your outlets covered the same event, the card is written from all of them together. You read a short summary on the card, and you can open a longer report and the links to the original articles if you want more.

![The front page of a reader's daily briefing](screenshots/front-page.png)

## What it's for

Following the news properly across several topics, several outlets and more than one language means opening the same event on five sites, skimming headlines that are mostly repeats, and still missing things that mattered because they were buried under what was merely recent. I built this to do that sorting. It reads the outlets you picked, merges the repeats into one story, decides what actually matters today, and hands back something you can finish reading.

It's one of two products I'm building under H72 Labs, my software studio (Hachad Solutions LLC). The idea behind the studio is AI tools that take a pile of noisy information and turn it into something clear. A daily news cycle is about as noisy as information gets.

## How to use it

This is the loop I designed it around:

1. **Accept your invite.** Open the link in your invite email and sign up **with the same email address the invite was sent to** (any other address is refused). Then confirm your email from the message that arrives. The invite works once and expires 7 days after I send it.
2. **Pick your topics and outlets.** There are 13 topics, including Moroccan politics, US politics, geopolitics, AI, world finance and European football, and 48 outlets, among them the BBC, Le Monde, the Financial Times, Hespress (one of Morocco's biggest news sites), Al Jazeera and ESPN. You need at least one of each for now.
3. **Press "Give me today's news."** The first run takes about a minute, a little longer if you follow every topic. Stay on the tab while it works (see the known issues below for why).
4. **Read the front page.** It holds up to six of the biggest stories across all your topics, and bigger boxes mean bigger stories. The row of topic buttons under the masthead takes you to each topic's own page, where the rest of that topic's stories are.
5. **Open a card.** Clicking a card enlarges it. Inside, **Generate full report** writes a longer version on the spot. The **Sources** button on a card flips it over to show the original articles it was written from.
6. **Save what you want to keep.** **☆ Save** on any card puts it on your **Saved** page.
7. **Come back tomorrow.** The menu at the top left has **Saved**, **History** (past days, each one kept as it was) and **Profile**, where you can change your topics and outlets.

Once a day is the intended rhythm, the way you'd pick up a morning paper. If you come back later the same day, the button reads **Complete today's news** and adds only stories that broke since your last run, marked **New**. There's a limit of 4 runs and 15 full reports per account in any 24 hours, and if you hit it the app tells you when you can go again.

It's built for a laptop or desktop screen. The newspaper layout needs width, and a phone version hasn't been designed yet.

## What it does differently

**One card per event.** A news app or a feed reader shows you each outlet's article separately, so a big story shows up five times. Here the five become one card, written from all five, with the links still there if you want to compare them yourself.

**Ranked by importance.** Your front page is ordered by how much each story matters, judged across all your topics at once. Recency and popularity don't decide the order.

**Your outlets, in one language.** You choose the sources, and they can mix Moroccan, French, Spanish, German, British and American outlets. Every card comes out in English regardless of the language of the originals.

**An edition you can finish.** A day's brief is a fixed set of stories with an end. There's no endless scroll, and there are no ads.

## How it works, briefly

When you press the button, the app pulls the latest articles from the outlets you picked, often several hundred of them. It groups articles about the same event together, then an AI model scores each story for how much it matters within its topic, and most get dropped at that step. The survivors are written up as cards by a stronger AI model, reconciling what the different outlets said. A final pass picks the ones that go on the front page.

## Already known, so no need to report these

**Current limits, by design for now:**

- Invite-only. There's no public sign-up yet.
- You choose from fixed lists of topics and outlets. Typing in your own isn't supported yet.
- The app can only follow outlets that publish an RSS feed (the standard feed format news sites offer), so some sites can't be added.
- Everything is written in English, including stories from French, Spanish and German outlets.
- No phone layout yet, as mentioned above.

**Known issues I'm already tracking:**

- **The same story sometimes shows up as two cards.** Usually that's two outlets framing one event differently enough that the app treats them as separate stories. It's the first thing on the quality list below.
- **Once in a while a story fails to be written and is left out.** A fix is live and I'm watching whether it holds.
- **If you switch to another tab while your edition is being generated, the cards may not appear when you come back.** Reloading the page brings them back, and nothing is lost. The cause is understood, and it's on the fix list.

If you see one of these, you don't need to tell me. If you see something that looks similar but behaves differently, do.

## What's planned next

None of this has dates yet. Each item is marked by how firmly it's on the list:

- **Planned:** agreed and on the list, just not scheduled.
- **Being considered:** designed on paper, not committed to.
- **Idea:** a direction I'm interested in, with nothing scoped.

### Making the brief itself better

- **Planned · Outlets become optional, and act as a preference rather than a filter.** Right now the app reads only the outlets you picked. The plan is that you'll need at least 3 topics but no outlets at all, and if you do pick outlets, they'll be favoured without being the only ones allowed. That way a big story that only an outlet you didn't pick covered can still reach you.
- **Planned · A "relevant / not relevant" button on every card.** Marking a card not relevant will ask why: it's a duplicate, it's old news, it's wrong, or something else you type in. Then the card is removed, with an undo in case you misclicked. Beyond cleaning up your page, your answers become the test set I use to judge whether the app is picking the right stories.
- **Planned · Fewer duplicate cards.** The idea is a second check on stories that look close to each other, asking an AI model directly whether they're the same event.
- **Planned · Redesigned sign-up and profile screens.** The topic and outlet pickers got the least design attention of anything in the app, and they'll be rebuilt after the outlet change above, since that changes what those screens need to do.

### New features

- **Being considered · Ask about anything.** A box where you type a one-off question ("what's happening with the Fed today?") and get a card back built from a live web search, added to your feed without disturbing the rest of it.
- **Being considered · Trending sub-topics.** A regularly refreshed list of what's hot inside a topic (a specific AI company, a specific conflict) that you could choose to follow.
- **Being considered · Sub-topics inside a topic.** Following a particular league, club, player or company rather than all of football or all of tech. The hard part is that news feeds are rarely that specific, so this needs its own filtering.
- **Being considered · A month calendar for history.** History is a list of dates today. A month-grid view would sit on top of what's already there, so it's a small change.

### Further out

- **Idea · An edition waiting for you in the morning.** Generated overnight on a schedule, the way a newspaper is printed before you wake up, instead of when you press the button. It would also cut what each edition costs me to run by about half.
- **Idea · Type your own topics and outlets**, beyond the fixed lists.
- **Idea · Social media as a source**, such as X.
- **Idea · A paid ad-free tier**, much later and only once there's real usage to base it on. For now it's free, with no ads.
- **Idea · Other AI providers.** Testing whether other models write as well for less.

Alongside all this, there's ongoing reliability and security work that won't change what you see.

## Feedback that helps me most

The single most useful thing you can do is **use it the way you'd actually use it**. Open it on the mornings you'd normally check the news, for a week or so, and not just once on the day you got the invite. Whether you come back without being reminded tells me more than anything you could write.

Then, when you have a minute, these are the questions I most want answered:

1. Did the front page pick what you'd call the day's biggest stories in your topics? If not, what was missing, or what didn't deserve to be there?
2. Was anything in a card wrong or misleading? A screenshot and the date help me trace it.
3. Is there an outlet or topic you wanted and couldn't find? Name it.
4. Was the wait of about a minute fine, or long enough that you'd skip it on a busy morning?
5. Was anything confusing the first time you used it?
6. Of the planned and considered items above, which would you use first, and which wouldn't you care about?
7. Would you rather have your edition waiting for you in the morning, or press the button when you're ready?
8. Would you mostly read this on your phone?

**If something breaks:** tell me what you did, roughly when (with your timezone), and send a screenshot if you can.

## Where to send it

Email **contact@h72labs.com**, H72 Labs' contact address, which is also on [h72labs.com](https://h72labs.com). Short and rough is fine. A two-line message after one morning's use is worth more to me than a polished review a month later.

Thanks again for giving it a real try.

Tarek
