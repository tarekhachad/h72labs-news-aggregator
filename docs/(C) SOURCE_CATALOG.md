# Source catalog

What the app offers as topics and outlets, which feed backs each one, and every topic and outlet from the approved lists that was left out, with the reason. The code is `src/types.ts` (`TOPICS`, `SOURCES`) and `src/config/feeds.ts` (`FEEDS`); this doc explains them and records the evidence. The approved lists it was built from are `notes-logs/(C) topic-catalog-proposal.md` and `notes-logs/(C) source-catalog-proposal.md`.

Measured live on 2026-10-02 from a laptop with `scripts/verify-feeds.mts`. A Vercel server may be blocked by more sites than a home connection, so a laptop pass is strong evidence, not a promise.

## The rules

**A feed ships only if the verification script passes it.** Run it with `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-feeds.mts` (or `--file candidates.json` to check feeds before adding them). It uses the same parser, User-Agent and 10-second timeout as the digest's own fetch (`src/lib/ingest.ts`) and fails a feed that:

- does not parse as RSS or Atom (a 403, a 404, an HTML page, or a response the parser cannot read);
- has no items, or no item dates (a feed without dates looks brand new on every run, so old items would be ingested again and again);
- has a newest item more than four days old (a digest reads back 48 hours at most);
- has an item with no title or no link (ingest removes duplicates by link, so linkless items collapse into one);
- sends a median snippet under 40 characters (headlines only, which gives the card writer nothing to work from);
- sits on a path that the `robots.txt` of any host its fetch passes through, redirects included, disallows for our crawler, or a host whose `robots.txt` cannot be reached (a 5xx or no answer, which RFC 9309 says to treat as a full block; a 404 means no rules).

**A topic ships only with at least 3 passing feeds.** Every passing feed that is genuinely about the topic is kept; there is no cap per topic in the catalog. A digest reads at most 6 feeds per topic, which is the pipeline's limit, not the catalog's.

**A source ships only with at least one passing feed.** An outlet with only an all-news feed is filed only where that is accurate (a world-news feed under Geopolitics), never under a narrower topic.

**Terms and robots rules are respected.** Reuters and AP forbid automated collection and are not included. A site that blocks our requests is left out; no block is worked around. The script enforces robots.txt rules; terms written as prose (often in robots.txt comments) were read by hand for every host in the catalog, and a new outlet whose terms forbid automated collection was left out. Several outlets that were already in the catalog carry similar prose; see *Outlet terms: a decision for Tarek* below. AllAfrica's RSS terms ask for credit and a link to its home page, which the card's source link to the article provides.

## How feeds are ordered within a topic

Order in `FEEDS` matters: when a digest reads only 6 of a topic's feeds, it takes the reader's preferred outlets first and fills the remaining slots from the top of this list. Feeds are ordered by three keys, in this order:

1. **English first.** The clustering model (`all-MiniLM-L6-v2`) is English-only, so a French or Arabic article rarely groups with English coverage of the same story and tends to become a card of its own. Non-English feeds go after the English ones.
2. **Fresh first.** A feed whose newest item was within 48 hours at measurement goes before one that was older, since a digest looks back 48 hours at most.
3. **Most text first.** Within those, the feed with the longer median snippet goes first, because it gives the card writer more to work from.

This is a measurement on one day, not a permanent ranking. Re-run the script and re-order when a topic's feeds change.

## Summary

- **Topics:** 65 shipped of the 68 candidates (the 67 approved topics other than Countries, which is wave 5, plus the existing Morocco topic). Football replaces European Football. Dropped: Startups & Venture Capital, Work & Careers, Telecom.
- **Sources:** 150 shipped of about 225 approved, including 41 of the 48 existing sources.
- **Feeds:** 371, all passing on the final run.

## Topics left out

- **Startups & Venture Capital:** 2 passing feeds (TechCrunch's startups feed, Crunchbase News). VentureBeat answered every request with 429 (rate-limited), Sifted's feed has no text, and the Fortune, Forbes, Business Insider, Guardian and FT startup feeds tried were missing (404) or stale. Bloomberg's technology feed passes but is not about startups.
- **Work & Careers:** 2 passing feeds (Fast Company work-life, The Guardian's work and careers). Harvard Business Review refused the connection, CNBC Make It's feed was 45 days stale, BBC Worklife 134 days, NYT Jobs over a year, and the Forbes and Business Insider career feeds were missing.
- **Telecom:** 2 reliable feeds (Light Reading, the FT's telecoms section). The Guardian's telecoms feed posts about once a week, so its newest item is past the four-day bar about half the time; it failed the final runs. The Register and Android Authority's telecom feeds are disallowed by robots.txt, and CNBC's candidate feed turned out to be its media section.

## Changes to the existing topics

- **European Football → Football**, with its feeds. Sky Sports and the English Marca feed were removed (see below); Marca returns with its Spanish La Liga feed, and Hesport is added.
- **Tech/AI:** ZDNet removed; IEEE Spectrum, The Guardian and MIT Technology Review added.
- **French Politics:** France24 and RFI (EN) now use their France feeds instead of their all-news feeds; BFM TV added.
- **Morocco Politics:** Le360 removed (headlines only); TelQuel added. Still exactly 3 feeds, and TelQuel's site throttles bursts of requests, so a full verification run can fail it once and pass it the next time.
- **Morocco:** Le360 and Medias24 removed; TelQuel and Yabiladi added. Challenge.ma's feed refused one run with a 403 and passed the next, so it is the weakest link here.
- **Morocco Finance:** Medias24, Le Boursier and Challenge.ma's market feed now refuse our requests (403) and Le360 sends headlines only, so all four are gone. Hespress (EN and FR), The North Africa Post and TelQuel replace them, with their economy feeds.
- **US Finance:** Yahoo Finance removed: its old feed was 10 days stale with no text, and its S&P 500 feed redirects to `feeds.finance.yahoo.com`, whose robots.txt disallows every crawler. NPR, Fortune, NYT and CBS News added (Forbes's business feed was tried and left out: it is mostly puzzle answers, sport and celebrity).
- **World Finance:** Al Jazeera removed, since it has only an all-news feed. The Financial Times feed moved from its homepage (which carries US politics and more) to its Global Economy section. The Guardian, DW, CNBC and BBC added.
- **American Football:** Sky Sports removed; The Guardian, The Athletic, BBC and RotoWire added.
- **US Politics:** Axios removed: its feed redirects to `api.axios.com`, whose robots.txt disallows every crawler. Every other existing feed kept; NPR, PBS NewsHour, CBS, NBC, ABC, LA Times and The Guardian added.
- **Geopolitics, Basketball, Tennis:** every existing feed kept, more outlets added.

## Outlets left out

Existing sources removed:

- **ZDNet:** every feed tried sends headlines only.
- **Le360:** every feed sends headlines only.
- **Medias24** and **Le Boursier** (hosted on medias24.com): 403 on every feed.
- **Sky Sports:** its feeds carry no item dates, so every old item would look new on every run.
- **Axios** and **Yahoo Finance:** their feeds redirect to hosts (`api.axios.com`, `feeds.finance.yahoo.com`) whose robots.txt disallows every crawler.

Approved outlets not added:

- **Refused our requests (403 or similar):** Arab News, Cricbuzz, Fierce Biotech, Golf Channel, Golf Digest, H24info, Inside the Games, Jeune Afrique, Le Point, Les Echos, Medical News Today, People, Entertainment Weekly, New Scientist (406). Harvard Business Review closed the connection.
- **Too slow to rely on:** Washington Post. Its feeds take 9 to 10 seconds to answer, against the digest's 10-second timeout, and timed out in two of four full runs.
- **Payment or rate limit on the feed:** USA Today and MMA Junkie (402), VentureBeat (429 on every request).
- **robots.txt disallows the feed:** The Register (blocks all unlisted crawlers), Times of Israel (`/feed/`), Finextra (`/rss/`), Euractiv (also 403), BoxingScene (also 404).
- **Response the parser cannot read:** The Independent, Ballotpedia News, Middle East Eye and Publishers Weekly send gzip-compressed feeds without being asked, which `rss-parser` does not decode, so the digest's fetch fails on them too. They could be added if ingest learns to decode compressed responses. The Real Deal's feed address returns its home page.
- **Refused one feed while others pass:** Euronews's Europe feed returned 406 on the final runs, so Euronews ships under Geopolitics only.
- **Headlines only:** L'Express, The National (UAE), Nature News, SCOTUSblog, Sifted.
- **Stale:** The Telegraph (104 days, also no text), Der Spiegel International (9 to 44 days), 90min (over a year), Krebs on Security (posts about weekly, newest over 4 days).
- **No working feed found:** Daily Monitor (404), Football365, Planet Rugby, PlanetF1, SNRTnews (all 404 with no feed advertised), News24 (its feed host does not resolve), Space.com (feeds empty).
- **Feed passes, but no topic it fits shipped:** Crunchbase News (Startups), Fast Company (Work & Careers), Light Reading (Telecom).
- **Terms forbid automated collection:** Polygon (Valnet: use of any robot to retrieve content "is prohibited without written permission"), VeloNews (Outside: "Scraping or data mining with automated tools is not allowed"), Libération (same wording as Le Monde, below).
- **Its only fitting feed is not about the topic:** Business Insider (its markets feed is mostly law-firm class-action notices and press releases), Quartz (its feed is mostly lifestyle lists), ABC News Australia (its feed is Australian local news, not Asia-Pacific), plus CBS Sports's "MMA" feed, which is a cross-sport newsletter (CBS Sports ships with its other sports).
- **Only an all-news feed that fits no topic:** La Tribune (a business daily; its general feed is not French politics) and El País English (its front-page feed carries US culture and sport as well as Europe and Latin America, and its section feeds all return an error).

## Fragile spots to re-check

These passed the final run but sit close to a limit. Re-run the script before relying on them, and first when a topic's page looks thin.

- **Slow or throttling hosts:** MercoPress answers in 6.5 to 9.7 seconds against the 10-second timeout. TelQuel and Challenge.ma refuse bursts of requests now and then; the verifier sends two requests per feed (the redirect walk, then the parse), so a full run can fail them once and pass them the next time.
- **Topics at the 3-feed floor with one slow feed:** Weather & Natural Disasters (ScienceDaily, newest item around 63 hours), Religion (NPR, around 88 hours), Banking (The Guardian, around 61 hours), and Morocco Politics (TelQuel throttling). One stale day drops any of them below 3 passing feeds.
- **Partly on topic:** IGN's all-content feed (about half TV and merchandise deals), NYT Energy & Environment under Energy & Oil (mostly climate policy), Fortune under US Finance (mostly AI in business), The Economist's International section under Geopolitics (global social trends), and Politico Europe, about a third of whose items are in German or French.
- **The same feed under two topics:** Bloomberg Markets (US Finance, World Finance, Markets & Investing), BBC Business and The Economist's finance section (World Finance, Economy), CBS MoneyWatch (US Finance, Personal Finance), Carbon Brief (Climate, Energy Transition), InsideEVs (Energy Transition, Automotive), The Diplomat (Geopolitics, Asia-Pacific), Engadget (Tech/AI, Consumer Tech). Ingest keeps an article only the first time it sees its link, so a reader with both topics gets those articles under the topic that comes first.

## Outlet terms: a decision for Tarek

The brief says to skip any outlet whose terms forbid automated collection. Reading every catalog host's robots.txt comments found that prose on outlets that were in the catalog before this change, which this change kept as they were:

- **NYT (and The Athletic, on nytimes.com):** "Use of any device, tool, or process designed to data mine or scrape the content using automated means is prohibited without prior written permission."
- **Al Jazeera:** content is for "personal, non-commercial use"; text and data mining, AI use and scraping by automated means are not permitted without written permission.
- **Le Monde:** "Il est interdit d'utiliser des robots d'indexation Web ou d'autres méthodes automatiques de feuilletage ou de navigation sur ce site Web" (automated browsing is forbidden); only licensed partners may use content beyond strictly individual use.
- **The Guardian:** other uses are not permitted, including AI-related purposes and any commercial purposes.
- **Financial Times:** any use of its content for machine learning or AI purposes is prohibited.
- **Le Figaro:** web monitoring and media monitoring need a licence.

All of them still publish RSS feeds, and their robots.txt rules allow our crawler on those feed paths. The app reads the feed, has Claude write its own summary, and links to the original. Whether that counts as the collection or AI use those terms forbid is a judgement for Tarek. Applying the rule strictly would remove NYT, The Athletic, Al Jazeera and Le Monde at least, and possibly The Guardian, the FT and Le Figaro. The Guardian is the first feed in most topics, so removing it would cost every topic one feed and drop any topic left with fewer than 3.

## Topics and their feeds

In shipping order, with the measurement each feed passed on: median snippet length and the age of its newest item.

### Technology and science

**Tech/AI** (10 feeds)

1. IEEE Spectrum: `https://spectrum.ieee.org/feeds/feed.rss` (5690 characters, newest 15.2h)
2. The Verge: `https://www.theverge.com/rss/index.xml` (684 characters, newest 4.1h)
3. The Guardian: `https://www.theguardian.com/technology/rss` (654 characters, newest 6.3h)
4. MIT Technology Review: `https://www.technologyreview.com/feed/` (330 characters, newest 9.4h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml` (154 characters, newest 7.1h)
6. TechCrunch: `https://techcrunch.com/feed/` (145 characters, newest 0.4h)
7. Wired: `https://www.wired.com/feed/rss` (143 characters, newest 5.3h)
8. BBC: `http://feeds.bbci.co.uk/news/technology/rss.xml` (88 characters, newest 0.2h)
9. Engadget: `https://www.engadget.com/rss.xml` (86 characters, newest 2.9h)
10. Ars Technica: `https://feeds.arstechnica.com/arstechnica/index` (80 characters, newest 3.9h)

**Cybersecurity** (6 feeds)

1. BleepingComputer: `https://www.bleepingcomputer.com/feed/` (211 characters, newest 6.2h)
2. The Record: `https://therecord.media/feed` (176 characters, newest 4.7h)
3. Wired: `https://www.wired.com/feed/category/security/latest/rss` (163 characters, newest 5.3h)
4. Dark Reading: `https://www.darkreading.com/rss.xml` (156 characters, newest 4.9h)
5. Ars Technica: `https://arstechnica.com/security/feed/` (84 characters, newest 2.2h)
6. The Guardian: `https://www.theguardian.com/technology/data-computer-security/rss` (596 characters, newest 92.2h)

**Consumer Tech & Gadgets** (7 feeds)

1. The Verge: `https://www.theverge.com/rss/tech/index.xml` (684 characters, newest 4.1h)
2. 9to5Mac: `https://9to5mac.com/feed/` (214 characters, newest 4.1h)
3. Tom's Hardware: `https://www.tomshardware.com/feeds/all` (157 characters, newest 9.2h)
4. Wired: `https://www.wired.com/feed/category/gear/latest/rss` (136 characters, newest 13.6h)
5. Engadget: `https://www.engadget.com/rss.xml` (86 characters, newest 2.9h)
6. Android Authority: `https://www.androidauthority.com/feed/` (78 characters, newest 3.5h)
7. Ars Technica: `https://feeds.arstechnica.com/arstechnica/gadgets` (72 characters, newest 7.9h)

**Gaming** (6 feeds)

1. The Guardian: `https://www.theguardian.com/games/rss` (1167 characters, newest 36.1h)
2. The Verge: `https://www.theverge.com/rss/games/index.xml` (722 characters, newest 8.6h)
3. IGN: `https://feeds.feedburner.com/ign/all` (113 characters, newest 4.7h)
4. Kotaku: `https://kotaku.com/rss` (80 characters, newest 1.2h)
5. Ars Technica: `https://feeds.arstechnica.com/arstechnica/gaming` (78 characters, newest 3.9h)
6. PC Gamer: `https://www.pcgamer.com/rss/` (56 characters, newest 2.4h)

**Space** (6 feeds)

1. The Guardian: `https://www.theguardian.com/science/space/rss` (579 characters, newest 21.9h)
2. SpaceNews: `https://spacenews.com/feed/` (314 characters, newest 34.1h)
3. Phys.org: `https://phys.org/rss-feed/space-news/` (294 characters, newest 1.9h)
4. Ars Technica: `https://arstechnica.com/space/feed/` (76 characters, newest 7.7h)
5. ScienceDaily: `https://www.sciencedaily.com/rss/space_time.xml` (321 characters, newest 60.8h)
6. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Space.xml` (134 characters, newest 88.2h)

**Science** (8 feeds)

1. The Guardian: `https://www.theguardian.com/science/rss` (629 characters, newest 21.9h)
2. Phys.org: `https://phys.org/rss-feed/` (338 characters, newest 1.9h)
3. ScienceDaily: `https://www.sciencedaily.com/rss/top/science.xml` (310 characters, newest 35.2h)
4. NPR: `https://feeds.npr.org/1007/rss.xml` (178 characters, newest 28h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Science.xml` (148 characters, newest 1.6h)
6. Scientific American: `http://rss.sciam.com/ScientificAmerican-Global` (105 characters, newest 6.2h)
7. Science (AAAS): `https://www.science.org/rss/news_current.xml` (98 characters, newest 19.9h)
8. BBC: `https://feeds.bbci.co.uk/news/science_and_environment/rss.xml` (97 characters, newest 1.6h)

**Climate & Environment** (7 feeds)

1. The Guardian: `https://www.theguardian.com/environment/rss` (684 characters, newest 12.2h)
2. Inside Climate News: `https://insideclimatenews.org/feed/` (350 characters, newest 2.4h)
3. DW: `https://rss.dw.com/xml/rss_en_environment` (178 characters, newest 11.4h)
4. NPR: `https://feeds.npr.org/1025/rss.xml` (175 characters, newest 26.9h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml` (133 characters, newest 1.6h)
6. Grist: `https://grist.org/feed/` (123 characters, newest 30.1h)
7. Carbon Brief: `https://www.carbonbrief.org/feed/` (244 characters, newest 59h)

**Energy Transition & Renewables** (6 feeds)

1. The Guardian: `https://www.theguardian.com/environment/renewableenergy/rss` (652 characters, newest 37.7h)
2. CleanTechnica: `https://cleantechnica.com/feed/` (444 characters, newest 0.6h)
3. Canary Media: `https://www.canarymedia.com/rss.rss` (316 characters, newest 11.2h)
4. Electrek: `https://electrek.co/feed/` (246 characters, newest 4.1h)
5. InsideEVs: `https://insideevs.com/rss/news/all/` (109 characters, newest 9.2h)
6. Carbon Brief: `https://www.carbonbrief.org/feed/` (244 characters, newest 59h)

**Health & Medicine** (7 feeds)

1. The Guardian: `https://www.theguardian.com/society/health/rss` (794 characters, newest 6.1h)
2. ScienceDaily: `https://www.sciencedaily.com/rss/health_medicine.xml` (324 characters, newest 36.8h)
3. NPR: `https://feeds.npr.org/1128/rss.xml` (180 characters, newest 6.9h)
4. CBS News: `https://www.cbsnews.com/latest/rss/health` (166 characters, newest 5.2h)
5. STAT News: `https://www.statnews.com/feed/` (147 characters, newest 5.2h)
6. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Health.xml` (139 characters, newest 2.8h)
7. BBC: `https://feeds.bbci.co.uk/news/health/rss.xml` (100 characters, newest 12.7h)

**Biotech & Pharma** (3 feeds)

1. Phys.org: `https://phys.org/rss-feed/biology-news/biotechnology/` (276 characters, newest 4.9h)
2. Endpoints News: `https://endpts.com/feed/` (221 characters, newest 6h)
3. STAT News: `https://www.statnews.com/category/biotech/feed/` (144 characters, newest 11.2h)

### Politics and world

**US Politics** (10 feeds)

1. The Guardian: `https://www.theguardian.com/us-news/us-politics/rss` (619 characters, newest 1.7h)
2. The Hill: `https://thehill.com/feed/` (340 characters, newest 0.5h)
3. PBS NewsHour: `https://www.pbs.org/newshour/feeds/rss/politics` (233 characters, newest 1.4h)
4. NPR: `https://feeds.npr.org/1014/rss.xml` (196 characters, newest 3.5h)
5. CBS News: `https://www.cbsnews.com/latest/rss/politics` (183 characters, newest 0.2h)
6. NBC News: `https://feeds.nbcnews.com/nbcnews/public/politics` (165 characters, newest 0.2h)
7. LA Times: `https://www.latimes.com/politics/rss2.0.xml` (163 characters, newest 10.4h)
8. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml` (157 characters, newest 0.6h)
9. ABC News: `https://feeds.abcnews.com/abcnews/politicsheadlines` (124 characters, newest 2.7h)
10. Politico: `https://rss.politico.com/politics-news.xml` (122 characters, newest 5.1h)

**Morocco Politics** (3 feeds)

1. Hespress (EN): `https://en.hespress.com/politics/feed` (522 characters, newest 3.3h)
2. Hespress (FR): `https://fr.hespress.com/politique/feed` (516 characters, newest 0.9h, not English)
3. TelQuel: `https://telquel.ma/categorie/maroc/politique/feed` (354 characters, newest 9h, not English)

**French Politics** (6 feeds)

1. RFI (EN): `https://www.rfi.fr/en/france/rss` (270 characters, newest 11.2h)
2. France24: `https://www.france24.com/en/france/rss` (319 characters, newest 82.5h)
3. RFI (FR): `https://www.rfi.fr/fr/france/rss` (452 characters, newest 3.2h, not English)
4. Le Monde: `https://www.lemonde.fr/politique/rss_full.xml` (255 characters, newest 0.4h, not English)
5. BFM TV: `https://www.bfmtv.com/rss/politique/` (249 characters, newest 3.3h, not English)
6. Le Figaro: `https://www.lefigaro.fr/rss/figaro_politique.xml` (195 characters, newest 6.7h, not English)

**Geopolitics** (17 feeds)

1. The Guardian: `https://www.theguardian.com/world/rss` (589 characters, newest 0.4h)
2. France24: `https://www.france24.com/en/rss` (438 characters, newest 3.6h)
3. PBS NewsHour: `https://www.pbs.org/newshour/feeds/rss/world` (316 characters, newest 1.6h)
4. DW: `https://rss.dw.com/xml/rss-en-world` (204 characters, newest 8.6h)
5. NPR: `https://feeds.npr.org/1004/rss.xml` (199 characters, newest 4.1h)
6. Euronews: `https://www.euronews.com/rss?level=theme&name=news` (182 characters, newest 4.5h)
7. LA Times: `https://www.latimes.com/world-nation/rss2.0.xml` (163 characters, newest 7.4h)
8. Sky News: `https://feeds.skynews.com/feeds/rss/world.xml` (159 characters, newest 8.6h)
9. NBC News: `https://feeds.nbcnews.com/nbcnews/public/world` (157 characters, newest 0.4h)
10. CBS News: `https://www.cbsnews.com/latest/rss/world` (151 characters, newest 0.6h)
11. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/World.xml` (147 characters, newest 1h)
12. The Diplomat: `https://thediplomat.com/feed/` (127 characters, newest 12h)
13. ABC News: `https://feeds.abcnews.com/abcnews/internationalheadlines` (112 characters, newest 0.1h)
14. BBC: `http://feeds.bbci.co.uk/news/world/rss.xml` (109 characters, newest 1.3h)
15. Al Jazeera: `https://www.aljazeera.com/xml/rss/all.xml` (111 characters, newest 0.4h)
16. Foreign Policy: `https://foreignpolicy.com/feed/` (80 characters, newest 4.2h)
17. The Economist: `https://www.economist.com/international/rss.xml` (70 characters, newest 39.6h)

**Morocco** (6 feeds)

1. Hespress (EN): `https://en.hespress.com/feed` (482 characters, newest 3.3h)
2. The North Africa Post: `https://northafricapost.com/feed` (367 characters, newest 8.4h)
3. Hespress (FR): `https://fr.hespress.com/feed` (526 characters, newest 0.1h, not English)
4. TelQuel: `https://telquel.ma/feed` (345 characters, newest 5.6h, not English)
5. Yabiladi: `https://www.yabiladi.com/rss/news.xml` (262 characters, newest 3.1h, not English)
6. Challenge.ma: `https://www.challenge.ma/feed` (168 characters, newest 60.9h, not English)

**UK Politics** (4 feeds)

1. The Guardian: `https://www.theguardian.com/politics/rss` (616 characters, newest 7.9h)
2. Sky News: `https://feeds.skynews.com/feeds/rss/politics.xml` (152 characters, newest 9.8h)
3. BBC: `https://feeds.bbci.co.uk/news/politics/rss.xml` (109 characters, newest 3.7h)
4. The Economist: `https://www.economist.com/britain/rss.xml` (57 characters, newest 36.5h)

**European Union** (6 feeds)

1. The Guardian: `https://www.theguardian.com/world/eu/rss` (561 characters, newest 14.7h)
2. France24: `https://www.france24.com/en/europe/rss` (373 characters, newest 9.2h)
3. DW: `https://rss.dw.com/xml/rss-en-eu` (198 characters, newest 8.6h)
4. Politico Europe: `https://www.politico.eu/feed/` (128 characters, newest 8.2h)
5. BBC: `https://feeds.bbci.co.uk/news/world/europe/rss.xml` (119 characters, newest 9.7h)
6. The Economist: `https://www.economist.com/europe/rss.xml` (65 characters, newest 8.8h)

**Middle East** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/middleeast/rss` (625 characters, newest 8.2h)
2. France24: `https://www.france24.com/en/middle-east/rss` (361 characters, newest 11.3h)
3. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml` (160 characters, newest 0.6h)
4. BBC: `https://feeds.bbci.co.uk/news/world/middle_east/rss.xml` (109 characters, newest 13.3h)

**Africa** (13 feeds)

1. The Guardian: `https://www.theguardian.com/world/africa/rss` (744 characters, newest 4h)
2. France24: `https://www.france24.com/en/africa/rss` (386 characters, newest 4.4h)
3. Mail & Guardian: `https://mg.co.za/rss/` (328 characters, newest 9.7h)
4. Premium Times (Nigeria): `https://www.premiumtimesng.com/feed` (301 characters, newest 0.8h)
5. AllAfrica: `https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf` (250 characters, newest 7.4h)
6. RFI (EN): `https://www.rfi.fr/en/africa/rss` (242 characters, newest 8.9h)
7. Daily Maverick: `https://www.dailymaverick.co.za/dmrss/` (216 characters, newest 5.9h)
8. DW: `https://rss.dw.com/xml/rss-en-africa` (187 characters, newest 10.4h)
9. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml` (153 characters, newest 3.1h)
10. BBC: `https://feeds.bbci.co.uk/news/world/africa/rss.xml` (114 characters, newest 1.3h)
11. The East African: `https://www.theeastafrican.co.ke/rss.xml` (92 characters, newest 10.7h)
12. Nation (Kenya): `https://nation.africa/kenya/rss.xml` (89 characters, newest 4.2h)
13. Le Monde Afrique: `https://www.lemonde.fr/afrique/rss_full.xml` (253 characters, newest 1h, not English)

**Asia-Pacific** (10 feeds)

1. The Guardian: `https://www.theguardian.com/world/asia-pacific/rss` (616 characters, newest 1.7h)
2. South China Morning Post: `https://www.scmp.com/rss/3/feed` (500 characters, newest 1.2h)
3. France24: `https://www.france24.com/en/asia-pacific/rss` (337 characters, newest 10.3h)
4. DW: `https://rss.dw.com/xml/rss-en-asia` (173 characters, newest 3.1h)
5. Channel NewsAsia: `https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511` (151 characters, newest 2h)
6. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml` (147 characters, newest 4h)
7. Japan Times: `https://www.japantimes.co.jp/feed/` (139 characters, newest 0.7h)
8. The Diplomat: `https://thediplomat.com/feed/` (127 characters, newest 12h)
9. BBC: `https://feeds.bbci.co.uk/news/world/asia/rss.xml` (105 characters, newest 2.2h)
10. The Economist: `https://www.economist.com/asia/rss.xml` (60 characters, newest 36.5h)

**Latin America** (7 feeds)

1. The Guardian: `https://www.theguardian.com/world/americas/rss` (650 characters, newest 4h)
2. France24: `https://www.france24.com/en/americas/rss` (350 characters, newest 8.9h)
3. MercoPress: `https://en.mercopress.com/rss` (331 characters, newest 17.3h)
4. Buenos Aires Times: `https://www.batimes.com.ar/feed` (164 characters, newest 3.9h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml` (156 characters, newest 2.8h)
6. BBC: `https://feeds.bbci.co.uk/news/world/latin_america/rss.xml` (110 characters, newest 14.8h)
7. The Economist: `https://www.economist.com/the-americas/rss.xml` (73 characters, newest 36.5h)

**Elections** (3 feeds)

1. France24: `https://www.france24.com/en/tag/elections/rss` (355 characters, newest 10.1h)
2. The Hill: `https://thehill.com/homenews/campaign/feed/` (338 characters, newest 4.1h)
3. NPR: `https://feeds.npr.org/139482413/rss.xml` (182 characters, newest 16.2h)

**Immigration** (3 feeds)

1. The Guardian: `https://www.theguardian.com/us-news/usimmigration/rss` (700 characters, newest 1.7h)
2. InfoMigrants: `https://www.infomigrants.net/en/rss/all.xml` (258 characters, newest 10.2h)
3. CBS News: `https://www.cbsnews.com/latest/rss/immigration` (175 characters, newest 24.4h)

**Defense & Security** (6 feeds)

1. War on the Rocks: `https://warontherocks.com/feed/` (753 characters, newest 17.7h)
2. The Hill: `https://thehill.com/policy/defense/feed/` (348 characters, newest 9.5h)
3. The War Zone: `https://www.twz.com/feed` (240 characters, newest 1.3h)
4. Breaking Defense: `https://breakingdefense.com/feed/` (150 characters, newest 3.4h)
5. Defense News: `https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml` (147 characters, newest 6.2h)
6. Politico: `https://rss.politico.com/defense.xml` (121 characters, newest 6.4h)

**Human Rights** (3 feeds)

1. Human Rights Watch: `https://www.hrw.org/rss/news` (4942 characters, newest 4.9h)
2. The Guardian: `https://www.theguardian.com/law/human-rights/rss` (699 characters, newest 40.2h)
3. Amnesty International: `https://www.amnesty.org/en/feed/` (519 characters, newest 9.9h)

### Business and economy

**Morocco Finance** (4 feeds)

1. Hespress (EN): `https://en.hespress.com/economy/feed` (471 characters, newest 9.9h)
2. The North Africa Post: `https://northafricapost.com/category/business/feed` (374 characters, newest 8.4h)
3. Hespress (FR): `https://fr.hespress.com/economie/feed` (517 characters, newest 2.5h, not English)
4. TelQuel: `https://telquel.ma/categorie/economie/feed` (350 characters, newest 8.5h, not English)

**US Finance** (7 feeds)

1. Bloomberg: `https://feeds.bloomberg.com/markets/news.rss` (228 characters, newest 1.5h)
2. NPR: `https://feeds.npr.org/1006/rss.xml` (180 characters, newest 6.5h)
3. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Business.xml` (145 characters, newest 0.6h)
4. Fortune: `https://fortune.com/feed/fortune-feeds/?id=3230629` (143 characters, newest 1.6h)
5. CNBC: `https://www.cnbc.com/id/10000664/device/rss/rss.html` (137 characters, newest 6.4h)
6. CBS News: `https://www.cbsnews.com/latest/rss/moneywatch` (136 characters, newest 4.4h)
7. MarketWatch: `https://feeds.content.dowjones.io/public/rss/mw_topstories` (110 characters, newest 2.5h)

**World Finance** (7 feeds)

1. The Guardian: `https://www.theguardian.com/business/rss` (589 characters, newest 6.3h)
2. Bloomberg: `https://feeds.bloomberg.com/markets/news.rss` (228 characters, newest 1.5h)
3. DW: `https://rss.dw.com/xml/rss-en-bus` (199 characters, newest 20.7h)
4. CNBC: `https://www.cnbc.com/id/100727362/device/rss/rss.html` (123 characters, newest 3.2h)
5. Financial Times: `https://www.ft.com/global-economy?format=rss` (99 characters, newest 4.9h)
6. BBC: `https://feeds.bbci.co.uk/news/business/rss.xml` (99 characters, newest 4.8h)
7. The Economist: `https://www.economist.com/finance-and-economics/rss.xml` (57 characters, newest 40.1h)

**Economy** (7 feeds)

1. The Guardian: `https://www.theguardian.com/business/economics/rss` (615 characters, newest 2.7h)
2. Bloomberg: `https://feeds.bloomberg.com/economics/news.rss` (177 characters, newest 4.8h)
3. NPR: `https://feeds.npr.org/1017/rss.xml` (161 characters, newest 11.3h)
4. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml` (145 characters, newest 8.1h)
5. CNBC: `https://www.cnbc.com/id/20910258/device/rss/rss.html` (126 characters, newest 7.6h)
6. BBC: `https://feeds.bbci.co.uk/news/business/rss.xml` (99 characters, newest 4.8h)
7. The Economist: `https://www.economist.com/finance-and-economics/rss.xml` (57 characters, newest 40.1h)

**Markets & Investing** (3 feeds)

1. Bloomberg: `https://feeds.bloomberg.com/markets/news.rss` (228 characters, newest 1.5h)
2. CNBC: `https://www.cnbc.com/id/15839069/device/rss/rss.html` (125 characters, newest 7.9h)
3. Financial Times: `https://www.ft.com/markets?format=rss` (97 characters, newest 4.7h)

**Personal Finance** (4 feeds)

1. The Guardian: `https://www.theguardian.com/money/rss` (588 characters, newest 8.5h)
2. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/YourMoney.xml` (146 characters, newest 4.6h)
3. CNBC: `https://www.cnbc.com/id/21324812/device/rss/rss.html` (145 characters, newest 3.9h)
4. CBS News: `https://www.cbsnews.com/latest/rss/moneywatch` (136 characters, newest 4.4h)

**Real Estate** (4 feeds)

1. The Guardian: `https://www.theguardian.com/money/property/rss` (516 characters, newest 19.2h)
2. CNBC: `https://www.cnbc.com/id/10000115/device/rss/rss.html` (131 characters, newest 36.5h)
3. HousingWire: `https://www.housingwire.com/feed/` (106 characters, newest 4.8h)
4. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/RealEstate.xml` (105 characters, newest 1.7h)

**Energy & Oil** (5 feeds)

1. The Guardian: `https://www.theguardian.com/business/energy-industry/rss` (594 characters, newest 6.3h)
2. OilPrice.com: `https://oilprice.com/rss/main` (545 characters, newest 3.7h)
3. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/EnergyEnvironment.xml` (146 characters, newest 1.6h)
4. CNBC: `https://www.cnbc.com/id/19836768/device/rss/rss.html` (145 characters, newest 5.1h)
5. Rigzone: `https://www.rigzone.com/news/rss/rigzone_latest.aspx` (127 characters, newest 5h)

**Crypto** (3 feeds)

1. Cointelegraph: `https://cointelegraph.com/rss` (151 characters, newest 4.4h)
2. CoinDesk: `https://www.coindesk.com/arc/outboundfeeds/rss/` (145 characters, newest 3.8h)
3. The Block: `https://www.theblock.co/rss.xml` (128 characters, newest 8h)

**Banking** (3 feeds)

1. Banking Dive: `https://www.bankingdive.com/feeds/news/` (152 characters, newest 8.9h)
2. Financial Times: `https://www.ft.com/banks?format=rss` (91 characters, newest 8.5h)
3. The Guardian: `https://www.theguardian.com/business/banking/rss` (560 characters, newest 61.2h)

**Retail & Consumer** (5 feeds)

1. The Guardian: `https://www.theguardian.com/business/retail/rss` (517 characters, newest 11.2h)
2. Forbes: `https://www.forbes.com/retail/feed/` (159 characters, newest 7.2h)
3. Retail Dive: `https://www.retaildive.com/feeds/news/` (143 characters, newest 9.1h)
4. CNBC: `https://www.cnbc.com/id/10000116/device/rss/rss.html` (125 characters, newest 10.2h)
5. WWD: `https://wwd.com/business-news/feed/` (112 characters, newest 4.7h)

**Automotive** (7 feeds)

1. Autocar: `https://www.autocar.co.uk/rss` (3476 characters, newest 13.2h)
2. The Verge: `https://www.theverge.com/rss/transportation/index.xml` (684 characters, newest 8h)
3. The Guardian: `https://www.theguardian.com/business/automotive-industry/rss` (603 characters, newest 38.4h)
4. CNBC: `https://www.cnbc.com/id/10000101/device/rss/rss.html` (128 characters, newest 7.9h)
5. Motor1: `https://www.motor1.com/rss/news/all/` (115 characters, newest 5.2h)
6. InsideEVs: `https://insideevs.com/rss/news/all/` (109 characters, newest 9.2h)
7. Car and Driver: `https://www.caranddriver.com/rss/all.xml/` (86 characters, newest 5.2h)

### Sports

**Football** (10 feeds)

1. The Guardian: `https://www.theguardian.com/football/rss` (693 characters, newest 4h)
2. Transfermarkt: `https://www.transfermarkt.com/rss/news` (193 characters, newest 14.2h)
3. ESPN: `https://www.espn.com/espn/rss/soccer/news` (134 characters, newest -0.8h)
4. BBC: `http://feeds.bbci.co.uk/sport/football/rss.xml` (133 characters, newest 2.7h)
5. The Athletic: `https://www.nytimes.com/athletic/rss/football/` (123 characters, newest 4.4h)
6. Football Italia: `https://www.football-italia.net/feed` (91 characters, newest 3.4h)
7. Hesport: `https://www.hesport.com/feed` (435 characters, newest 1.7h, not English)
8. RMC Sport: `https://rmcsport.bfmtv.com/rss/football/` (265 characters, newest 2.8h, not English)
9. Kicker: `https://newsfeed.kicker.de/news/bundesliga` (188 characters, newest 3.7h, not English)
10. Marca: `https://e00-marca.uecdn.es/rss/futbol/primera-division.xml` (95 characters, newest 3.4h, not English)

**Basketball** (8 feeds)

1. The Guardian: `https://www.theguardian.com/sport/nba/rss` (584 characters, newest 27.3h)
2. Hoops Rumors: `https://www.hoopsrumors.com/feed` (331 characters, newest 1h)
3. RotoWire: `https://www.rotowire.com/rss/news.php?sport=nba` (185 characters, newest 3.2h)
4. ESPN: `https://www.espn.com/espn/rss/nba/news` (142 characters, newest 0h)
5. BBC: `https://feeds.bbci.co.uk/sport/basketball/rss.xml` (137 characters, newest 39.6h)
6. The Athletic: `https://www.nytimes.com/athletic/rss/nba/` (121 characters, newest 4.4h)
7. CBS Sports: `https://www.cbssports.com/rss/headlines/nba/` (105 characters, newest 4.4h)
8. Yahoo Sports: `https://sports.yahoo.com/nba/rss/` (95 characters, newest 2h)

**Tennis** (8 feeds)

1. The Guardian: `https://www.theguardian.com/sport/tennis/rss` (818 characters, newest 29.3h)
2. Tennis Majors: `https://www.tennismajors.com/feed/` (263 characters, newest 1.1h)
3. Tennis365: `https://www.tennis365.com/feed/` (180 characters, newest 4.2h)
4. UbiTennis: `https://www.ubitennis.com/feed/` (148 characters, newest 6.1h)
5. ESPN: `https://www.espn.com/espn/rss/tennis/news` (146 characters, newest 6.9h)
6. BBC: `http://feeds.bbci.co.uk/sport/tennis/rss.xml` (135 characters, newest 8.8h)
7. The Athletic: `https://www.nytimes.com/athletic/rss/tennis/` (114 characters, newest 16.2h)
8. L'Équipe: `https://dwh.lequipe.fr/api/edito/rss?path=/Tennis/` (211 characters, newest 3.6h, not English)

**American Football** (8 feeds)

1. The Guardian: `https://www.theguardian.com/sport/nfl/rss` (572 characters, newest 6.8h)
2. RotoWire: `https://www.rotowire.com/rss/news.php?sport=nfl` (251 characters, newest 0.5h)
3. ESPN: `https://www.espn.com/espn/rss/nfl/news` (140 characters, newest 1.6h)
4. The Athletic: `https://www.nytimes.com/athletic/rss/nfl/` (124 characters, newest 4.2h)
5. BBC: `https://feeds.bbci.co.uk/sport/american-football/rss.xml` (124 characters, newest 14.3h)
6. Pro Football Talk: `https://profootballtalk.nbcsports.com/feed/` (118 characters, newest 0.5h)
7. CBS Sports: `https://www.cbssports.com/rss/headlines/nfl/` (99 characters, newest 0.7h)
8. Yahoo Sports: `https://sports.yahoo.com/nfl/rss/` (93 characters, newest 0.1h)

**Formula 1** (6 feeds)

1. The Guardian: `https://www.theguardian.com/sport/formulaone/rss` (626 characters, newest 9.8h)
2. Motorsport.com: `https://www.motorsport.com/rss/f1/news/` (408 characters, newest 3.5h)
3. Autosport: `https://www.autosport.com/rss/f1/news/` (407 characters, newest 11.5h)
4. ESPN: `https://www.espn.com/espn/rss/f1/news` (152 characters, newest 7.1h)
5. The Race: `https://www.the-race.com/feed/` (127 characters, newest 10.8h)
6. BBC: `https://feeds.bbci.co.uk/sport/formula1/rss.xml` (102 characters, newest 13.9h)

**Cricket** (5 feeds)

1. The Guardian: `https://www.theguardian.com/sport/cricket/rss` (638 characters, newest 7.7h)
2. Times of India: `https://timesofindia.indiatimes.com/rssfeeds/54829575.cms` (290 characters, newest 10.8h)
3. BBC: `https://feeds.bbci.co.uk/sport/cricket/rss.xml` (119 characters, newest 2.8h)
4. ESPNcricinfo: `https://www.espncricinfo.com/rss/content/story/feeds/0.xml` (102 characters, newest 4.5h)
5. The Hindu: `https://www.thehindu.com/sport/cricket/feeder/default.rss` (98 characters, newest 10.5h)

**Rugby** (5 feeds)

1. The Guardian: `https://www.theguardian.com/sport/rugby-union/rss` (711 characters, newest 3.7h)
2. RugbyPass: `https://www.rugbypass.com/feeds/rss/` (156 characters, newest 0.1h)
3. BBC: `https://feeds.bbci.co.uk/sport/rugby-union/rss.xml` (125 characters, newest 3h)
4. RMC Sport: `https://rmcsport.bfmtv.com/rss/rugby/` (292 characters, newest 10.7h, not English)
5. L'Équipe: `https://dwh.lequipe.fr/api/edito/rss?path=/Rugby/` (197 characters, newest 2.7h, not English)

**Golf** (5 feeds)

1. The Guardian: `https://www.theguardian.com/sport/golf/rss` (683 characters, newest 32h)
2. ESPN: `https://www.espn.com/espn/rss/golf/news` (149 characters, newest 19.8h)
3. Yahoo Sports: `https://sports.yahoo.com/golf/rss/` (144 characters, newest 1h)
4. BBC: `https://feeds.bbci.co.uk/sport/golf/rss.xml` (143 characters, newest 6.8h)
5. CBS Sports: `https://www.cbssports.com/rss/headlines/golf/` (97 characters, newest 10h)

**Boxing & MMA** (4 feeds)

1. MMA Fighting: `https://www.mmafighting.com/rss/index.xml` (2864 characters, newest 1.2h)
2. The Guardian: `https://www.theguardian.com/sport/boxing/rss` (747 characters, newest 14h)
3. ESPN: `https://www.espn.com/espn/rss/boxing/news` (127 characters, newest 3.9h)
4. BBC: `https://feeds.bbci.co.uk/sport/boxing/rss.xml` (105 characters, newest 10.9h)

**Cycling** (4 feeds)

1. BBC: `https://feeds.bbci.co.uk/sport/cycling/rss.xml` (148 characters, newest 12.7h)
2. Cyclingnews: `https://www.cyclingnews.com/feeds.xml` (96 characters, newest 4.8h)
3. RMC Sport: `https://rmcsport.bfmtv.com/rss/cyclisme/` (247 characters, newest 13.8h, not English)
4. L'Équipe: `https://dwh.lequipe.fr/api/edito/rss?path=/Cyclisme/` (184 characters, newest 5h, not English)

**Baseball** (6 feeds)

1. MLB Trade Rumors: `https://www.mlbtraderumors.com/feed` (332 characters, newest 0.8h)
2. RotoWire: `https://www.rotowire.com/rss/news.php?sport=mlb` (166 characters, newest 4.6h)
3. The Athletic: `https://www.nytimes.com/athletic/rss/mlb/` (122 characters, newest 0.8h)
4. ESPN: `https://www.espn.com/espn/rss/mlb/news` (120 characters, newest 1.4h)
5. CBS Sports: `https://www.cbssports.com/rss/headlines/mlb/` (104 characters, newest 4.1h)
6. Yahoo Sports: `https://sports.yahoo.com/mlb/rss/` (100 characters, newest 1.2h)

**Olympics & Athletics** (4 feeds)

1. The Guardian: `https://www.theguardian.com/sport/athletics/rss` (616 characters, newest 13.2h)
2. ESPN: `https://www.espn.com/espn/rss/oly/news` (168 characters, newest 13.9h)
3. BBC: `https://feeds.bbci.co.uk/sport/athletics/rss.xml` (140 characters, newest 11h)
4. L'Équipe: `https://dwh.lequipe.fr/api/edito/rss?path=/Athletisme/` (204 characters, newest 15h, not English)

### Culture and life

**Film & TV** (6 feeds)

1. The Guardian: `https://www.theguardian.com/film/rss` (1182 characters, newest 1.2h)
2. Deadline: `https://deadline.com/feed/` (335 characters, newest 0.7h)
3. Variety: `https://variety.com/feed/` (332 characters, newest 1.2h)
4. IndieWire: `https://www.indiewire.com/feed/` (158 characters, newest 1.1h)
5. The Hollywood Reporter: `https://www.hollywoodreporter.com/feed/` (153 characters, newest 0.2h)
6. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Movies.xml` (117 characters, newest 10.2h)

**Music** (7 feeds)

1. The Guardian: `https://www.theguardian.com/music/rss` (1133 characters, newest 7.8h)
2. NME: `https://www.nme.com/news/music/feed` (230 characters, newest 9.3h)
3. NPR: `https://feeds.npr.org/1039/rss.xml` (181 characters, newest 9.2h)
4. Rolling Stone: `https://www.rollingstone.com/music/feed/` (132 characters, newest 6.2h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Music.xml` (132 characters, newest 16.2h)
6. Pitchfork: `https://pitchfork.com/feed/feed-news/rss` (86 characters, newest 7.5h)
7. Billboard: `https://www.billboard.com/feed/` (83 characters, newest 0.6h)

**Books** (4 feeds)

1. The Guardian: `https://www.theguardian.com/books/rss` (972 characters, newest 14.2h)
2. Literary Hub: `https://lithub.com/feed/` (237 characters, newest 6.1h)
3. NPR: `https://feeds.npr.org/1032/rss.xml` (197 characters, newest 16.2h)
4. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Books.xml` (131 characters, newest 8.1h)

**Art & Design** (6 feeds)

1. The Guardian: `https://www.theguardian.com/artanddesign/rss` (589 characters, newest 8.2h)
2. Dezeen: `https://www.dezeen.com/design/feed/` (453 characters, newest 10.2h)
3. Designboom: `https://www.designboom.com/design/feed/` (301 characters, newest 10h)
4. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/ArtandDesign.xml` (151 characters, newest 9.7h)
5. The Art Newspaper: `https://www.theartnewspaper.com/rss.xml` (146 characters, newest 2.9h)
6. ARTnews: `https://www.artnews.com/feed/` (101 characters, newest 3.9h)

**Architecture** (4 feeds)

1. The Guardian: `https://www.theguardian.com/artanddesign/architecture/rss` (762 characters, newest 15h)
2. ArchDaily: `https://feeds.feedburner.com/Archdaily` (468 characters, newest 8.2h)
3. Dezeen: `https://www.dezeen.com/architecture/feed/` (468 characters, newest 8.2h)
4. Designboom: `https://www.designboom.com/architecture/feed/` (278 characters, newest 4.6h)

**Food & Drink** (3 feeds)

1. Eater: `https://www.eater.com/rss/index.xml` (4893 characters, newest 8.4h)
2. The Guardian: `https://www.theguardian.com/food/rss` (808 characters, newest 10.2h)
3. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/DiningandWine.xml` (106 characters, newest 3.7h)

**Travel** (5 feeds)

1. Skift: `https://skift.com/feed/` (175 characters, newest 3.2h)
2. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Travel.xml` (142 characters, newest 4.2h)
3. CNBC: `https://www.cnbc.com/id/10000739/device/rss/rss.html` (120 characters, newest 5.9h)
4. Condé Nast Traveler: `https://www.cntraveler.com/feed/rss` (116 characters, newest 2.6h)
5. The Guardian: `https://www.theguardian.com/travel/rss` (835 characters, newest 90.5h)

**Fashion** (4 feeds)

1. The Guardian: `https://www.theguardian.com/fashion/rss` (724 characters, newest 8.5h)
2. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/FashionandStyle.xml` (114 characters, newest 2.1h)
3. WWD: `https://wwd.com/feed/` (113 characters, newest 3.9h)
4. Vogue: `https://www.vogue.com/feed/rss` (109 characters, newest 0.1h)

**Celebrity & Entertainment** (5 feeds)

1. The Guardian: `https://www.theguardian.com/culture/rss` (833 characters, newest 5h)
2. CBS News: `https://www.cbsnews.com/latest/rss/entertainment` (175 characters, newest 7h)
3. Sky News: `https://feeds.skynews.com/feeds/rss/entertainment.xml` (128 characters, newest 14.4h)
4. ABC News: `https://feeds.abcnews.com/abcnews/entertainmentheadlines` (110 characters, newest 8.8h)
5. BBC: `https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml` (101 characters, newest 1.7h)

**Education** (5 feeds)

1. The Guardian: `https://www.theguardian.com/education/rss` (777 characters, newest 7.9h)
2. Inside Higher Ed: `https://www.insidehighered.com/rss.xml` (231 characters, newest 3.3h)
3. NPR: `https://feeds.npr.org/1013/rss.xml` (185 characters, newest 40.2h)
4. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Education.xml` (155 characters, newest 0.6h)
5. BBC: `https://feeds.bbci.co.uk/news/education/rss.xml` (113 characters, newest 42.1h)

**Religion** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/religion/rss` (637 characters, newest 8.1h)
2. Religion News Service: `https://religionnews.com/feed/` (193 characters, newest 5.9h)
3. NPR: `https://feeds.npr.org/1016/rss.xml` (165 characters, newest 88.4h)

**Health & Wellness** (5 feeds)

1. The Guardian: `https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss` (649 characters, newest 11.2h)
2. ScienceDaily: `https://www.sciencedaily.com/rss/health_medicine/nutrition.xml` (337 characters, newest 36.8h)
3. NBC News: `https://feeds.nbcnews.com/nbcnews/public/health` (156 characters, newest 1.5h)
4. ABC News: `https://feeds.abcnews.com/abcnews/healthheadlines` (148 characters, newest 9.7h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Well.xml` (131 characters, newest 2.3h)

### Society

**Law & Courts** (4 feeds)

1. The Guardian: `https://www.theguardian.com/law/rss` (713 characters, newest 6.4h)
2. The Hill: `https://thehill.com/regulation/court-battles/feed/` (358 characters, newest 1.5h)
3. NPR: `https://feeds.npr.org/1070/rss.xml` (184 characters, newest 14.8h)
4. Lawfare: `https://www.lawfaremedia.org/feeds/articles` (130 characters, newest 8.2h)

**Crime** (3 feeds)

1. The Guardian: `https://www.theguardian.com/us-news/us-crime/rss` (567 characters, newest 1.3h)
2. CBS News: `https://www.cbsnews.com/latest/rss/crime` (175 characters, newest 0.2h)
3. The Marshall Project: `https://www.themarshallproject.org/rss/recent` (136 characters, newest 10.2h)

**Weather & Natural Disasters** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/extreme-weather/rss` (620 characters, newest 4.9h)
2. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/Weather.xml` (118 characters, newest 4h)
3. ScienceDaily: `https://www.sciencedaily.com/rss/earth_climate/natural_disasters.xml` (395 characters, newest 63.6h)

**Media & Journalism** (5 feeds)

1. The Guardian: `https://www.theguardian.com/media/rss` (615 characters, newest 8.1h)
2. Nieman Lab: `https://www.niemanlab.org/feed/` (339 characters, newest 29.6h)
3. Poynter: `https://www.poynter.org/feed/` (297 characters, newest 13.7h)
4. Press Gazette: `https://pressgazette.co.uk/feed/` (195 characters, newest 14.2h)
5. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/MediaandAdvertising.xml` (140 characters, newest 5.3h)
