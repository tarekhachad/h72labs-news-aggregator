# Source catalog

What the app offers as topics and outlets, which feed backs each one, and every topic and outlet from the approved lists that was left out, with the reason. The code is `src/types.ts` (`TOPICS`, `SOURCES`), `src/config/feeds.ts` (`FEEDS`) and, for the Countries topic, `src/config/countries.ts` (`COUNTRIES`, `COUNTRY_FEEDS`; see *Countries* at the end); this doc explains them and records the evidence. The approved lists it was built from are `notes-logs/(C) topic-catalog-proposal.md` and `notes-logs/(C) source-catalog-proposal.md`.

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
- **Countries:** 99 offered inside the Countries topic, with 428 more feeds and 331 more outlets (2026-10-03; see *Countries*).

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

## Countries

The Countries topic is a container: a reader picks countries inside it, and each picked country is read like a topic of its own (up to 6 feed slots, the reader's preferred outlets first, then the order below). The code is `src/config/countries.ts` (`COUNTRIES`, `COUNTRY_FEEDS`). Measured live on 2026-10-03 from a laptop with `scripts/verify-feeds.mts`, which checks every country feed as well as every topic feed.

### The rules for countries

- **The same bar as topics.** Every country feed passed the same checks as a topic feed (see *The rules* above), and the same ordering applies: English first, then fresh, then the longest median snippet.
- **A country ships only with at least 3 passing feeds from at least 3 different outlets.** Two editions of one outlet (an English and a local-language feed) count as one outlet here, because they mostly carry the same stories.
- **A feed must be about that one country.** A regional feed (East Africa, the South Caucasus, Central Asia, Latin America, Asia-Pacific) is not filed under a country, and neither is a sport-only feed or a commentary site that covers every subject.
- **Terms are read the same way as for topics,** from the prose in each new host's robots.txt, with one addition: a host that asks not to have its content fed into AI models (a `Content-Signal: ai-input=no` line, or wording that rules out any AI-related use) is left out, because the card writer is an AI model reading the feed. Restrictions limited to training AI models, or to text and data mining, are noted below for Tarek but do not exclude a feed.
- **A feed shared with a topic is read once.** Thirteen country feeds are also topic feeds (six of Morocco's are the Morocco topic's, one of them spelled `/feed` there and `/feed/` here, two of France's are French Politics's, and one or two each for South Africa, Nigeria, Japan and Argentina). A reader who picks both reads such a feed once, under whichever comes first in reading order, and the other gives that slot to its next feed.
- **Countries are listed alphabetically,** which is the order the picker shows them and the order a digest reads them. When two of a reader's countries carry the same article, the first one in this order keeps it.

### Summary

- **Countries:** 99 shipped of 153 considered.
- **Feeds:** 428, all of which passed the bar on 2026-10-03. 411 passed the final full run of the verifier; the other 17 are AllAfrica's, which passed an earlier run the same day and then failed only because AllAfrica's server refused this machine (see below). MercoPress (3 feeds; its host answers in 6 to 10 seconds against the 10-second timeout, as already noted for topics) and Myanmar Now each failed one measuring run and passed the final one.
- **Sources:** 331 new outlets, added to `SOURCES`. Every outlet in `SOURCES` still appears in at least one topic or country feed.

### AllAfrica refused this machine

AllAfrica's per-country feeds passed in the first run (Morocco, Uganda, Kenya, Nigeria, Ghana, South Africa, Egypt, Algeria, Tunisia, Senegal, Ethiopia, Tanzania, Rwanda, Zimbabwe, Zambia, DR Congo and Mali, with a median snippet of 175 to 263 characters). After roughly 150 requests across several runs (the verifier sends three per feed: robots.txt, the redirect walk and the fetch), its server began refusing every connection from this laptop, and was still refusing at the end of the session. No shipped country needs its AllAfrica feed to reach 3. A digest reads at most one AllAfrica feed per picked African country plus one for the Africa topic, so a reader's own digest sends a handful of requests, not hundreds; re-run the verifier once the block lifts.

AllAfrica also publishes a feed for most countries left out below for having only 2 feeds. Once it can be verified, it would very likely bring Malawi, Niger, Guinea, Sierra Leone, Liberia, Benin, Madagascar, South Sudan, Burundi, Chad and Somalia to 3.

### Countries left out

Africa:

- **Somalia:** 2 passing (Somali Guardian, Caasimada, the second in Somali). Hiiraan's and Garowe Online's feeds were missing (404) or failing (500), and The Guardian's Somalia feed was 18 days stale.
- **Malawi:** 2 (Nyasa Times, Malawi24).
- **Niger:** 2 (Tamtaminfo, Niger Inter). ActuNiger's feed was missing; Aniamey reset the connection.
- **Guinea:** 2 (Guinéenews, Mosaïque Guinée). Africaguinee's feed was missing.
- **Sierra Leone:** 2 (Sierra Leone Telegraph, Sierraloaded). Awoko's certificate does not match its host name.
- **Liberia:** 2 (FrontPage Africa, The New Dawn). The Liberian Observer rate-limited us (429).
- **Benin:** 2 (La Nouvelle Tribune, 24 Haubenin). Banouto's feed was missing.
- **Togo:** 1 (iciLome). Republicoftogo.com and Togo First had no feed; Togo Breaking News sent a feed the parser cannot read.
- **Madagascar:** 2 (NewsMada, Madagascar Tribune). Midi Madagasikara's and L'Express de Madagascar's feeds could not be parsed; 2424.mg was 35 days stale.
- **Mauritius:** 1 (News Moris). Defimedia sends headlines only, Le Mauricien was 58 days stale, L'Express had no feed.
- **Angola:** none. Novo Jornal refused (406), Club-K refused (403), Ver Angola and Expansão could not be parsed, Angop had no feed.
- **South Sudan:** 2 (Radio Tamazuj, Eye Radio). Sudans Post's South Sudan feed could not be parsed.
- **Burundi:** 2 (Iwacu, SOS Médias Burundi). Burundi Eco was 33 days stale.
- **Chad:** 2 (Tchadinfos, Le Pays). Journal du Tchad's robots.txt disallows its feed; Alwihda Info's was missing.
- **Mauritania:** none. Cridem timed out; Alakhbar refused the connection.
- **Eswatini, Lesotho, Gabon, Congo-Brazzaville, Eritrea, Djibouti, Cape Verde:** only AllAfrica's country feed was tried, and it could not be reached.

Middle East:

- **Saudi Arabia:** 2 (Saudi Gazette, The Guardian). Arab News and Al Arabiya refuse our requests (403); Asharq Al-Awsat sends headlines only.
- **United Arab Emirates:** 2 (The Guardian, Arabian Business). The National and Gulf News send headlines only; Khaleej Times and Gulf Today send feeds the parser cannot read.
- **Qatar:** 1 (Doha News). The Peninsula and Qatar Tribune could not be parsed; Gulf Times's robots.txt disallows its feed; The Guardian's Qatar feed was 18 days stale.
- **Yemen:** none. The Guardian's Yemen feed was 4 days stale; South24 had no feed.
- **Kuwait, Bahrain, Oman:** at most 1 each (Bahrain This Week). The rest refused, timed out, had no feed or could not be parsed.

Europe and Central Asia:

- **Netherlands:** 2 (The Guardian, NOS). NU.nl and RTL Nieuws pass the bar but their publisher's terms forbid automated collection (see below); NL Times sends no item dates; DutchNews's robots.txt disallows its feed; De Volkskrant sends headlines only.
- **Belgium:** 2 (La Libre Belgique, RTBF). HLN is left out on terms; The Brussels Times's feed could not be parsed; VRT NWS sends headlines only; De Standaard refuses (403); Le Soir's feed was empty.
- **Luxembourg:** none. Luxembourg Times, Luxemburger Wort and Virgule all pass the bar but their publisher's terms forbid automated collection; RTL Today could not be parsed.
- **Estonia:** 2 outlets (ERR and Postimees, each in English and Estonian). The Baltic Times sends no item dates; Estonian World was 4 days stale.
- **Lithuania:** 2 (LRT, Baltic News Network). 15min's feed was empty; Delfi sends no dates or text.
- **Georgia:** 2 (OC Media, Netgazeti). Civil.ge's robots.txt disallows its feed; JAMnews covers the whole South Caucasus; Georgia Today failed (500).
- **Armenia:** 1 (Hetq). Asbarez and The Armenian Weekly pass but are US diaspora papers; Armenpress and CivilNet had no feed; Azatutyun's robots.txt disallows its feed.
- **Azerbaijan:** 1 (Report.az). Trend sends headlines only; APA could not be parsed.
- **Kyrgyzstan:** 2 (24.kg, Kloop). AKIpress sends headlines only; The Times of Central Asia covers the whole region.

Americas:

- **Colombia:** 2 (Colombia One, The Guardian). El Tiempo passes but its terms forbid automated collection; Semana sends headlines only; El Espectador's feed was empty.
- **Ecuador:** 2 (Expreso, El Comercio). El Universo's robots.txt disallows its feed; Primicias, Ecuavisa and Plan V had no feed; GK refuses (403).
- **Bolivia:** 1 (Opinión). **Paraguay:** 1 (La Nación). MercoPress's Paraguay feed was 36 days stale; ABC Color sends headlines only.
- **Jamaica:** 1 (Nationwide 90FM). The Gleaner's robots.txt could not be reached; the Jamaica Observer sends headlines only.
- **Trinidad and Tobago:** 2 (Trinidad Express, CNC3). Newsday timed out; the Trinidad Guardian failed (502).
- **Haiti:** 1 (The Haitian Times). Le Nouvelliste sends headlines only; The Guardian's Haiti feed was 13 days stale.
- **Honduras, El Salvador:** none. Every feed tried was missing or could not be parsed; Criterio.hn's robots.txt disallows its feed.

Asia and the Pacific:

- **Taiwan:** 2 (Taiwan Insight, New Bloom). The Reporter passes but its terms forbid automated collection; the Taipei Times sends no dates or text; Focus Taiwan had no feed; Taiwan News could not be parsed.
- **Vietnam:** 2 outlets (VnExpress, in English and Vietnamese, and Tuoi Tre News). VietnamPlus, Vietnam News and The Saigon Times could not be parsed.
- **Sri Lanka:** 2 (EconomyNext, LankaBusinessOnline, both business-only). The Daily Mirror, NewsFirst and The Island could not be parsed; Ada Derana sends no item dates; several others refuse (403).
- **Laos, Mongolia, Fiji, Papua New Guinea:** 1 each (Laotian Times, News.mn, FBC News, Post-Courier).

### Outlets left out of countries that shipped

On terms:

- **Forbid automated collection:** i (Associated Newspapers: "Use of any device, tool, or process designed to data mine or scrape the content using automated means is prohibited"), El Tiempo (same wording), FAZ and Der Spiegel ("The use of robots or other automated means to access … or collect or mine data without the express permission … is strictly prohibited"), Dagens Nyheter (Bonnier News: scraping or collecting content needs prior written permission), HLN, NU.nl and RTL Nieuws (DPG Media: collecting data "by means of screen scraping (or any other automated method)" is not allowed), Irish Independent, Luxembourg Times, Luxemburger Wort and Virgule (Mediahuis: no "use of programs or robots for automatic data collection"), The Reporter (Taiwan).
- **Rule out feeding content to AI:** The Sydney Morning Herald and The Age (Nine "expressly prohibits the use of any Nine content or data … for any machine learning and/or artificial intelligence"), NZ Herald (no "artificial intelligence-related purposes"), The Slovak Spectator, Dagbladet and the New Straits Times (`Content-Signal: ai-input=no`).

On judgement:

- **State outlets that serve as a government's voice rather than a newsroom:** Tehran Times (Iran) and SAnews (South Africa's government news service).
- **Not about one country:** NYT Asia Pacific (China), BBC US & Canada (United States), Infobae (all of Latin America, under Peru), NK News (filed under North Korea, not South Korea), The EastAfrican (East Africa; already in the Africa topic), JAMnews and The Times of Central Asia (regional).
- **Sport only:** Kawowo Sports (Uganda), Marca (Spain).
- **Not news reporting:** The Conversation (academic commentary on every subject), Rice Media, Life in Norway, Keep Talking Greece, Polish News, Vindobona and Brno Daily (lifestyle or expatriate sites).
- **Unreliable on the final run:** Mothership (Singapore), whose feed parsed in one run and failed the next with a character the parser rejects; Dakaractu (Senegal), which dropped the connection on the last two runs; NewsDay (Zimbabwe), which began refusing our requests (403); Nile Post (Uganda), which sends headlines only.

### Judgement calls for Tarek

- **Countries that need The Guardian to reach 3:** Australia, Bangladesh, Iran, Iraq, Nepal, Palestine and South Korea. If *Outlet terms: a decision for Tarek* above ends with The Guardian removed, these seven drop out unless another feed is found. Mali and Algeria also use Le Monde, and the United States uses the NYT, but each still has 3 without them.
- **State-owned or state-aligned outlets kept,** because each is a main national outlet in a country with an independent press alongside it, or the only English-language source: Anadolu Agency and Daily Sabah (Turkey), Fana (Ethiopia), Sidwaya (Burkina Faso), Daily News (Tanzania), KBC (Kenya), APS (Senegal), Antara (Indonesia), Andina (Peru), Agência Brasil (Brazil), Ukrinform (Ukraine), BTA (Bulgaria), Khmer Times (Cambodia), RTHK (Hong Kong).
- **Advocacy outlets kept:** Mondoweiss and +972 Magazine (Palestine), JNS (Israel), Hungarian Conservative (Hungary).
- **Places that are not UN member states:** Palestine, Hong Kong and Puerto Rico are offered alongside countries, since a reader looks for them in the same list.
- **Terms short of a ban, kept:** text and data mining reservations (NRK, Tagesschau, Gazeta Wyborcza, Die Presse) and AI-training-only restrictions (VG, Aftenposten, SVT, SRF and RTS, which explicitly allow retrieval and grounding, Seneweb, Ivoirematin, Grapevine, Divergentes, Dnevnik, Portugal Resident, Yonhap). The ai-input exclusions above are the strict reading; reversing them would restore Australia's and New Zealand's two biggest papers.
- **Non-English countries:** the clustering model is English-only, so a country read mostly in another language groups its own stories less well. No English feed at all: Burkina Faso, Côte d'Ivoire, Guatemala, Nicaragua, Peru, Puerto Rico, Serbia, Slovakia. Fewer than 3 English feeds: Algeria, Austria, Bulgaria, Chile, Costa Rica, Croatia, Cuba, Czech Republic, DR Congo, Denmark, Dominican Republic, Finland, Indonesia, Jordan, Kazakhstan, Latvia, Mali, Mexico, Mozambique, Norway, Panama, Poland, Portugal, Romania, Senegal, Sweden, Switzerland, Tunisia, Uruguay, Venezuela.
- **The source picker grows:** `SOURCES` goes from 150 to 481 outlets, most of them relevant to one country only. The preferred-sources picker lists all of them.

### Fragile spots

- **Countries at exactly 3 feeds:** Australia, Bangladesh, Botswana, Burkina Faso, Cambodia, Chile, Costa Rica, Côte d'Ivoire, Croatia, Denmark, Dominican Republic, Iran, Iraq, Jordan, Kazakhstan, Malta, Mozambique, Namibia, Nepal, New Zealand, Palestine, Portugal, Puerto Rico, Slovakia, South Korea, The Gambia, Uruguay. One failing feed takes any of them below the bar.
- **At the floor with a slow host:** Chile and Uruguay each count MercoPress, which answers in 6 to 10 seconds. Iraq's third feed is The Guardian's Iraq page, newest item 75 hours old at measurement; Puerto Rico's Centro de Periodismo Investigativo posted 84 hours before.
- **Feeds near the 96-hour line:** Congo Indépendant (DR Congo, 95h), The Guardian's Ghana page (89h), Ethiopia Insight (80h), AllAfrica's Senegal feed (88h), and The Guardian's Sudan and Japan pages (84h and 83h).
- **Two problems in the topic catalog, found while measuring countries:** Nation (Kenya)'s feed `https://nation.africa/kenya/rss.xml` (the Africa topic) now returns 404, and France24's France feed (French Politics) was 103 hours stale. Both are outside this change; the full verifier run lists them.

### Countries and their feeds

In shipping order, with the measurement each feed passed on: median snippet length and the age of its newest item.

**Afghanistan** (4 feeds)

1. Khaama Press: `https://www.khaama.com/feed/` (480 characters, newest 4.1h)
2. Hasht-e Subh: `https://8am.media/eng/feed/` (470 characters, newest 3.8h)
3. KabulNow: `https://kabulnow.com/feed/` (382 characters, newest 3.2h)
4. Amu TV: `https://amu.tv/feed/` (276 characters, newest 3.9h)

**Algeria** (5 feeds)

1. AllAfrica: `https://allafrica.com/tools/headlines/rdf/algeria/headlines.rdf` (263 characters, newest 38.2h, measured in the earlier run)
2. TSA: `https://www.tsa-algerie.com/feed/` (471 characters, newest 1.5h)
3. Echorouk: `https://www.echoroukonline.com/feed` (434 characters, newest 1.6h)
4. Algérie360: `https://www.algerie360.com/feed/` (281 characters, newest 3.3h)
5. Le Monde: `https://www.lemonde.fr/algerie/rss_full.xml` (218 characters, newest 50.8h)

**Argentina** (5 feeds)

1. MercoPress: `https://en.mercopress.com/rss/argentina` (355 characters, newest 4.4h, measured in the earlier run)
2. Buenos Aires Herald: `https://buenosairesherald.com/feed` (244 characters, newest 7.7h)
3. Buenos Aires Times: `https://www.batimes.com.ar/feed` (167 characters, newest 2.4h)
4. La Nación: `https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml` (153 characters, newest 0.1h)
5. Clarín: `https://www.clarin.com/rss/lo-ultimo/` (94 characters, newest 0.5h)

**Australia** (3 feeds)

1. The Guardian: `https://www.theguardian.com/australia-news/rss` (610 characters, newest 2.9h)
2. Crikey: `https://www.crikey.com.au/feed/` (247 characters, newest 39.9h)
3. ABC (Australia): `https://www.abc.net.au/news/feed/51120/rss.xml` (147 characters, newest 0.2h)

**Austria** (4 feeds)

1. The Local Austria: `https://feeds.thelocal.com/rss/at` (188 characters, newest 35.3h)
2. Die Presse: `https://www.diepresse.com/rss/` (174 characters, newest 3.7h)
3. Der Standard: `https://www.derstandard.at/rss` (144 characters, newest 2.4h)
4. Kurier: `https://kurier.at/xml/rss` (120 characters, newest 0.8h)

**Bangladesh** (3 feeds)

1. Dhaka Tribune: `https://www.dhakatribune.com/feed/` (128 characters, newest 3.1h)
2. The Business Standard: `https://www.tbsnews.net/top-news/rss.xml` (106 characters, newest 2.1h)
3. The Guardian: `https://www.theguardian.com/world/bangladesh/rss` (647 characters, newest 60.9h)

**Botswana** (3 feeds)

1. Sunday Standard: `https://www.sundaystandard.info/feed/` (597 characters, newest 15.2h)
2. Weekend Post: `https://www.weekendpost.co.bw/feed` (570 characters, newest 30.8h)
3. The Botswana Gazette: `https://www.thegazette.news/feed/` (360 characters, newest 1.4h)

**Brazil** (5 feeds)

1. Agência Brasil: `https://agenciabrasil.ebc.com.br/en/rss/ultimasnoticias/feed.xml` (4140 characters, newest 8h)
2. The Guardian: `https://www.theguardian.com/world/brazil/rss` (614 characters, newest 14.9h)
3. The Rio Times: `https://www.riotimesonline.com/feed/` (246 characters, newest 3.5h)
4. G1: `https://g1.globo.com/rss/g1/` (2094 characters, newest 0.2h)
5. Folha de S.Paulo: `https://feeds.folha.uol.com.br/emcimadahora/rss091.xml` (285 characters, newest 0h)

**Bulgaria** (4 feeds)

1. BTA: `https://www.bta.bg/en/rss/free` (1695 characters, newest 3.6h)
2. Novinite: `https://www.novinite.com/services/news_rdf.php` (519 characters, newest 2.9h)
3. Mediapool: `https://www.mediapool.bg/rss/` (630 characters, newest 1.6h)
4. Dnevnik: `https://www.dnevnik.bg/rss/` (229 characters, newest 3.4h)

**Burkina Faso** (3 feeds)

1. Lefaso.net: `https://lefaso.net/spip.php?page=backend` (503 characters, newest 1.3h)
2. Burkina24: `https://burkina24.com/feed/` (503 characters, newest 0.6h)
3. Sidwaya: `https://www.sidwaya.info/feed/` (349 characters, newest 9.3h)

**Cambodia** (3 feeds)

1. Phnom Penh Post: `https://www.phnompenhpost.com/rss` (376 characters, newest 8.5h)
2. Khmer Times: `https://www.khmertimeskh.com/feed/` (315 characters, newest 4.5h)
3. CamboJA News: `https://cambojanews.com/feed/` (265 characters, newest 8.2h)

**Cameroon** (4 feeds)

1. Mimi Mefo Info: `https://mimimefoinfos.com/feed/` (497 characters, newest 10.3h)
2. Cameroon News Agency: `https://cameroonnewsagency.com/feed/` (463 characters, newest 40.5h)
3. Data Cameroon: `https://datacameroon.com/feed/` (290 characters, newest 31.8h)
4. Actu Cameroun: `https://actucameroun.com/feed/` (161 characters, newest -0.2h)

**Canada** (5 feeds)

1. Global News: `https://globalnews.ca/canada/feed/` (175 characters, newest 6.9h)
2. National Post: `https://nationalpost.com/category/news/canada/feed` (123 characters, newest 2.8h)
3. The Globe and Mail: `https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/canada/` (117 characters, newest 0.2h)
4. The Guardian: `https://www.theguardian.com/world/canada/rss` (664 characters, newest 60.8h)
5. Radio-Canada: `https://ici.radio-canada.ca/rss/4159` (102 characters, newest 0h)

**Chile** (3 feeds)

1. MercoPress: `https://en.mercopress.com/rss/chile` (308 characters, newest 4.4h, measured in the earlier run)
2. Cooperativa: `https://www.cooperativa.cl/noticias/site/tax/port/all/rss_3___1.xml` (2258 characters, newest 1.8h)
3. La Tercera: `https://www.latercera.com/arc/outboundfeeds/rss/?outputType=xml` (223 characters, newest 0.2h)

**China** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/china/rss` (640 characters, newest 27.1h)
2. South China Morning Post: `https://www.scmp.com/rss/4/feed` (501 characters, newest 7.9h)
3. China Digital Times: `https://chinadigitaltimes.net/feed/` (340 characters, newest 26h)
4. BBC: `https://feeds.bbci.co.uk/news/world/asia/china/rss.xml` (103 characters, newest 70.5h)

**Costa Rica** (3 feeds)

1. The Tico Times: `https://ticotimes.net/feed` (152 characters, newest 1.7h)
2. Delfino: `https://delfino.cr/feed` (148 characters, newest -0.7h)
3. La Nación (Costa Rica): `https://www.nacion.com/arc/outboundfeeds/rss/?outputType=xml` (133 characters, newest 0.2h)

**Côte d'Ivoire** (3 feeds)

1. Linfodrome: `https://www.linfodrome.com/rss` (277 characters, newest 0.8h)
2. Connectionivoirienne: `https://www.connectionivoirienne.net/feed/` (272 characters, newest 0.3h)
3. Ivoirematin: `https://www.ivoirematin.com/feed/` (200 characters, newest 9.6h)

**Croatia** (3 feeds)

1. Total Croatia News: `https://total-croatia-news.com/feed/` (460 characters, newest 3.9h)
2. Croatia Week: `https://www.croatiaweek.com/feed/` (217 characters, newest 4.2h)
3. Index.hr: `https://www.index.hr/rss` (99 characters, newest 0.2h)

**Cuba** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/cuba/rss` (570 characters, newest 30.7h)
2. Havana Times: `https://havanatimes.org/feed/` (219 characters, newest 6.9h)
3. Diario de Cuba: `https://diariodecuba.com/rss.xml` (200 characters, newest 0.8h)
4. 14ymedio: `https://www.14ymedio.com/rss/` (118 characters, newest 3.8h)

**Cyprus** (4 feeds)

1. Financial Mirror: `https://www.financialmirror.com/feed/` (725 characters, newest 30.3h)
2. In-Cyprus: `https://in-cyprus.philenews.com/feed/` (356 characters, newest 7h)
3. Cyprus Mail: `https://cyprus-mail.com/category/cyprus/feed/` (349 characters, newest 8.2h)
4. Politis: `https://politis.com.cy/feed/` (157 characters, newest 2.6h)

**Czech Republic** (5 feeds)

1. Expats.cz: `https://www.expats.cz/feed` (135 characters, newest 7.3h)
2. Radio Prague International: `https://english.radio.cz/rcz-rss/en` (62 characters, newest 6.9h)
3. ČT24: `https://ct24.ceskatelevize.cz/rss/hlavni-zpravy` (428 characters, newest 1.9h)
4. iRozhlas: `https://www.irozhlas.cz/rss/irozhlas` (301 characters, newest 0.7h)
5. Novinky.cz: `https://www.novinky.cz/rss` (282 characters, newest 1.6h)

**Denmark** (3 feeds)

1. The Copenhagen Post: `https://cphpost.dk/feed/` (349 characters, newest 10.8h)
2. The Local Denmark: `https://feeds.thelocal.com/rss/dk` (161 characters, newest 12.2h)
3. Politiken: `https://politiken.dk/rss/senestenyt.rss` (127 characters, newest 1.1h)

**Dominican Republic** (3 feeds)

1. Dominican Today: `https://dominicantoday.com/feed/` (217 characters, newest 3.9h)
2. El Nuevo Diario (DR): `https://elnuevodiario.com.do/feed/` (517 characters, newest 0.1h)
3. N Digital: `https://n.com.do/feed/` (472 characters, newest 0.3h)

**DR Congo** (5 feeds)

1. AllAfrica: `https://allafrica.com/tools/headlines/rdf/congo_kinshasa/headlines.rdf` (210 characters, newest 28.4h, measured in the earlier run)
2. Actualite.cd: `https://actualite.cd/feed` (534 characters, newest 2h)
3. Zoom Eco: `https://zoom-eco.net/feed/` (345 characters, newest 4.1h)
4. Politico.cd: `https://www.politico.cd/feed/` (304 characters, newest 3.8h)
5. Congo Indépendant: `https://www.congoindependant.com/feed/` (231 characters, newest 95.3h)

**Egypt** (6 feeds)

1. Egyptian Streets: `https://egyptianstreets.com/feed/` (1425 characters, newest 8.3h)
2. The Guardian: `https://www.theguardian.com/world/egypt/rss` (584 characters, newest 11.9h)
3. Mada Masr: `https://www.madamasr.com/en/feed/` (572 characters, newest 4.8h)
4. Egypt Independent: `https://www.egyptindependent.com/feed/` (465 characters, newest 9.3h)
5. Daily News Egypt: `https://www.dailynewsegypt.com/feed/` (381 characters, newest 1.5h)
6. AllAfrica: `https://allafrica.com/tools/headlines/rdf/egypt/headlines.rdf` (263 characters, newest 27.8h, measured in the earlier run)

**Ethiopia** (5 feeds)

1. Ethiopia Observer: `https://www.ethiopiaobserver.com/feed/` (716 characters, newest 37.7h)
2. Capital Ethiopia: `https://www.capitalethiopia.com/feed/` (368 characters, newest 14.3h)
3. Fana: `https://www.fanabc.com/english/feed/` (367 characters, newest 5.2h)
4. AllAfrica: `https://allafrica.com/tools/headlines/rdf/ethiopia/headlines.rdf` (252 characters, newest 27.8h, measured in the earlier run)
5. Ethiopia Insight: `https://www.ethiopia-insight.com/feed/` (167 characters, newest 80.3h)

**Finland** (4 feeds)

1. Helsinki Times: `https://www.helsinkitimes.fi/?format=feed&type=rss` (466 characters, newest 7.2h)
2. The Guardian: `https://www.theguardian.com/world/finland/rss` (592 characters, newest 55.4h)
3. Yle: `https://yle.fi/rss/uutiset/paauutiset` (123 characters, newest 2.5h)
4. Helsingin Sanomat: `https://www.hs.fi/rss/tuoreimmat.xml` (115 characters, newest 0.5h)

**France** (6 feeds)

1. The Guardian: `https://www.theguardian.com/world/france/rss` (591 characters, newest 17.9h)
2. RFI (EN): `https://www.rfi.fr/en/france/rss` (280 characters, newest 7.4h)
3. The Local France: `https://feeds.thelocal.com/rss/fr` (194 characters, newest 9.7h)
4. Le Monde: `https://www.lemonde.fr/politique/rss_full.xml` (240 characters, newest 1.5h)
5. Le Figaro: `https://www.lefigaro.fr/rss/figaro_actualites.xml` (203 characters, newest 0.2h)
6. BFM TV: `https://www.bfmtv.com/rss/news-24-7/` (156 characters, newest 0.1h)

**Germany** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/germany/rss` (768 characters, newest 6.7h)
2. DW: `https://rss.dw.com/rdf/rss-en-ger` (197 characters, newest 10.9h)
3. The Local Germany: `https://feeds.thelocal.com/rss/de` (191 characters, newest 12.2h)
4. Tagesschau: `https://www.tagesschau.de/xml/rss2` (226 characters, newest 3.4h)

**Ghana** (5 feeds)

1. Graphic Online: `https://www.graphic.com.gh/news/general-news?format=feed&type=rss` (3089 characters, newest 2.2h)
2. MyJoyOnline: `https://www.myjoyonline.com/feed/` (228 characters, newest 0.3h)
3. AllAfrica: `https://allafrica.com/tools/headlines/rdf/ghana/headlines.rdf` (209 characters, newest 40.3h, measured in the earlier run)
4. 3News: `https://3news.com/feed/` (135 characters, newest 0.9h)
5. The Guardian: `https://www.theguardian.com/world/ghana/rss` (581 characters, newest 88.9h)

**Greece** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/greece/rss` (564 characters, newest 7.1h)
2. Greek City Times: `https://greekcitytimes.com/feed/` (375 characters, newest 1.4h)
3. Kathimerini: `https://www.ekathimerini.com/infeeds/rss/nx-rss-feed.xml` (179 characters, newest 1.8h)
4. To Vima: `https://www.tovima.com/feed/` (159 characters, newest 3.9h)

**Guatemala** (5 feeds)

1. ConCriterio: `https://concriterio.gt/feed/` (382 characters, newest 25.9h)
2. Plaza Pública: `https://www.plazapublica.com.gt/feed` (340 characters, newest 31.4h)
3. Agencia Ocote: `https://www.agenciaocote.com/feed/` (290 characters, newest 10h)
4. Prensa Libre: `https://www.prensalibre.com/feed/` (146 characters, newest 0.4h)
5. República (Guatemala): `https://republica.gt/feed/` (135 characters, newest 1.3h)

**Hong Kong** (4 feeds)

1. RTHK: `https://rthk.hk/rthk/news/rss/e_expressnews_elocal.xml` (1421 characters, newest 8.4h)
2. The Witness: `https://thewitnesshk.com/feed/` (926 characters, newest 4h)
3. South China Morning Post: `https://www.scmp.com/rss/2/feed` (500 characters, newest 0.4h)
4. Hong Kong Free Press: `https://hongkongfp.com/feed/` (337 characters, newest 15.5h)

**Hungary** (7 feeds)

1. Hungary Today: `https://hungarytoday.hu/feed/` (481 characters, newest 15.9h)
2. Hungarian Conservative: `https://www.hungarianconservative.com/feed/` (402 characters, newest 7.8h)
3. Daily News Hungary: `https://dailynewshungary.com/feed/` (212 characters, newest 5.8h)
4. Budapest Times: `https://www.budapesttimes.hu/feed/` (54 characters, newest 14.6h)
5. HVG: `https://hvg.hu/rss` (116 characters, newest 2h)
6. 444.hu: `https://444.hu/feed` (94 characters, newest 2.7h)
7. Index.hu: `https://index.hu/24ora/rss/` (51 characters, newest 2.5h)

**Iceland** (4 feeds)

1. RÚV English: `https://www.ruv.is/rss/english` (1839 characters, newest 29.5h)
2. Grapevine: `https://grapevine.is/feed/` (333 characters, newest 5.6h)
3. Iceland Review: `https://www.icelandreview.com/feed/` (283 characters, newest 5.4h)
4. Iceland Monitor: `https://icelandmonitor.mbl.is/rss/` (208 characters, newest 8.4h)

**India** (5 feeds)

1. The Guardian: `https://www.theguardian.com/world/india/rss` (643 characters, newest 31.2h)
2. NDTV: `https://feeds.feedburner.com/ndtvnews-india-news` (169 characters, newest 1.6h)
3. Hindustan Times: `https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml` (138 characters, newest 1.2h)
4. The Hindu: `https://www.thehindu.com/news/national/feeder/default.rss` (135 characters, newest 0.2h)
5. Scroll: `https://feeds.feedburner.com/ScrollinArticles.rss` (127 characters, newest 5.4h)

**Indonesia** (4 feeds)

1. Antara: `https://en.antaranews.com/rss/news.xml` (119 characters, newest 6.6h)
2. The Guardian: `https://www.theguardian.com/world/indonesia/rss` (553 characters, newest 66.9h)
3. Republika: `https://www.republika.co.id/rss` (233 characters, newest 0.6h)
4. CNN Indonesia: `https://www.cnnindonesia.com/nasional/rss` (145 characters, newest 6.9h)

**Iran** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/iran/rss` (669 characters, newest 3.3h)
2. Amwaj.media: `https://amwaj.media/rss` (589 characters, newest 3.8h)
3. IranWire: `https://iranwire.com/en/feed/` (140 characters, newest 30.4h)

**Iraq** (3 feeds)

1. Iraqi News: `https://www.iraqinews.com/feed/` (292 characters, newest 11.9h)
2. Kurdistan24: `https://www.kurdistan24.net/en/rss.xml` (163 characters, newest 1.6h)
3. The Guardian: `https://www.theguardian.com/world/iraq/rss` (612 characters, newest 75.2h)

**Ireland** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/ireland/rss` (592 characters, newest 36.6h)
2. RTÉ: `https://www.rte.ie/feeds/rss/?index=/news/` (147 characters, newest 1.5h)
3. Irish Examiner: `https://www.irishexaminer.com/feed/35-top_news.xml` (120 characters, newest 0.3h)
4. The Irish Times: `https://www.irishtimes.com/arc/outboundfeeds/feed-irish-news/?outputType=xml` (96 characters, newest 1.1h)

**Israel** (5 feeds)

1. The Guardian: `https://www.theguardian.com/world/israel/rss` (645 characters, newest 9.9h)
2. Israel Hayom: `https://www.israelhayom.com/feed/` (469 characters, newest 2.6h)
3. Haaretz: `https://www.haaretz.com/srv/haaretz-latest-headlines` (208 characters, newest 1.6h)
4. The Jerusalem Post: `https://www.jpost.com/rss/rssfeedsfrontpage.aspx` (176 characters, newest -0.7h)
5. JNS: `https://www.jns.org/feed/` (138 characters, newest 3.6h)

**Italy** (5 feeds)

1. ANSA: `https://www.ansa.it/english/news/english_nr_rss.xml` (1139 characters, newest 4h)
2. The Guardian: `https://www.theguardian.com/world/italy/rss` (637 characters, newest 11.9h)
3. Decode39: `https://decode39.com/feed/` (511 characters, newest 29.9h)
4. The Local Italy: `https://feeds.thelocal.com/rss/it` (173 characters, newest 34.7h)
5. la Repubblica: `https://www.repubblica.it/rss/homepage/rss2.0.xml` (170 characters, newest 3.1h)

**Japan** (5 feeds)

1. Nippon.com: `https://www.nippon.com/en/feed/` (224 characters, newest 0.9h)
2. Japan Today: `https://japantoday.com/feed` (171 characters, newest 0.7h)
3. The Mainichi: `https://mainichi.jp/english/rss/etc/english_latest.rss` (150 characters, newest 0.9h)
4. Japan Times: `https://www.japantimes.co.jp/feed/` (138 characters, newest 16.8h)
5. The Guardian: `https://www.theguardian.com/world/japan/rss` (611 characters, newest 82.7h)

**Jordan** (3 feeds)

1. Roya News: `https://en.royanews.tv/rss` (1334 characters, newest 0.2h)
2. Jordan News: `https://www.jordannews.jo/rss` (253 characters, newest 5.9h)
3. 7iber: `https://www.7iber.com/feed/` (188 characters, newest 56.6h)

**Kazakhstan** (3 feeds)

1. The Astana Times: `https://astanatimes.com/feed/` (592 characters, newest 14.1h)
2. Kursiv: `https://kz.kursiv.media/en/feed/` (362 characters, newest 15.7h)
3. Tengrinews: `https://tengrinews.kz/news.rss` (141 characters, newest 0h)

**Kenya** (7 feeds)

1. KBC: `https://www.kbc.co.ke/feed/` (445 characters, newest 5.2h)
2. AllAfrica: `https://allafrica.com/tools/headlines/rdf/kenya/headlines.rdf` (228 characters, newest 27.8h, measured in the earlier run)
3. Capital FM (Kenya): `https://www.capitalfm.co.ke/news/feed` (187 characters, newest 8.1h)
4. Tuko: `https://www.tuko.co.ke/rss/all.rss` (157 characters, newest 1.2h)
5. Kenyans.co.ke: `https://www.kenyans.co.ke/feeds/news` (150 characters, newest 5.3h)
6. The Standard (Kenya): `https://www.standardmedia.co.ke/rss/headlines.php` (143 characters, newest 0.9h)
7. The Guardian: `https://www.theguardian.com/world/kenya/rss` (610 characters, newest 49.3h)

**Latvia** (5 feeds)

1. LSM: `https://eng.lsm.lv/rss/` (238 characters, newest 3.1h)
2. Baltic News Network: `https://bnn-news.com/feed` (140 characters, newest 2.6h)
3. TVNET: `https://www.tvnet.lv/rss` (295 characters, newest 0.3h)
4. LSM (Latvian): `https://www.lsm.lv/rss/` (265 characters, newest 0.3h)
5. Delfi (Latvia): `https://www.delfi.lv/rss/index.xml` (237 characters, newest 0.3h)

**Lebanon** (4 feeds)

1. Beirut Today: `https://beirut-today.com/feed/` (637 characters, newest 11.6h)
2. The961: `https://www.the961.com/feed/` (435 characters, newest 28.7h)
3. NOW Lebanon: `https://nowlebanon.com/feed/` (137 characters, newest 33.7h)
4. Annahar: `https://www.annahar.com/rss` (1671 characters, newest 0.8h)

**Libya** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/libya/rss` (583 characters, newest 12.9h)
2. Libya Update: `https://libyaupdate.com/feed/` (553 characters, newest 2.6h)
3. Libya Review: `https://libyareview.com/feed/` (495 characters, newest 3.1h)
4. Libya Herald: `https://libyaherald.com/feed/` (153 characters, newest 10.1h)

**Malaysia** (4 feeds)

1. Free Malaysia Today: `https://www.freemalaysiatoday.com/feed/` (132 characters, newest 5.5h)
2. Malay Mail: `https://www.malaymail.com/feed/rss/malaysia` (117 characters, newest 9.3h)
3. Malaysiakini: `https://www.malaysiakini.com/rss/en/news.rss` (62 characters, newest 9.9h)
4. The Guardian: `https://www.theguardian.com/world/malaysia/rss` (551 characters, newest 67.9h)

**Mali** (4 feeds)

1. AllAfrica: `https://allafrica.com/tools/headlines/rdf/mali/headlines.rdf` (241 characters, newest 52.5h, measured in the earlier run)
2. Studio Tamani: `https://www.studiotamani.org/feed/` (544 characters, newest 27.9h)
3. Mali Actu: `https://maliactu.net/feed/` (511 characters, newest 2.9h)
4. Le Monde: `https://www.lemonde.fr/mali/rss_full.xml` (227 characters, newest 29.9h)

**Malta** (3 feeds)

1. Lovin Malta: `https://lovinmalta.com/feed/` (384 characters, newest 8.1h)
2. The Shift: `https://theshiftnews.com/feed/` (369 characters, newest 6.9h)
3. Newsbook: `https://newsbook.com.mt/en/feed/` (239 characters, newest 7.6h)

**Mexico** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/mexico/rss` (597 characters, newest 0.4h)
2. Mexico News Daily: `https://mexiconewsdaily.com/feed/` (266 characters, newest 1.9h)
3. La Jornada: `https://www.jornada.com.mx/rss/edicion.xml` (306 characters, newest 14.1h)
4. El Financiero: `https://www.elfinanciero.com.mx/arc/outboundfeeds/rss/?outputType=xml` (139 characters, newest 0.2h)

**Morocco** (8 feeds)

1. Hespress (EN): `https://en.hespress.com/feed` (497 characters, newest 0.7h)
2. The North Africa Post: `https://northafricapost.com/feed` (366 characters, newest 8.1h)
3. AllAfrica: `https://allafrica.com/tools/headlines/rdf/morocco/headlines.rdf` (223 characters, newest 40.3h, measured in the earlier run)
4. Hespress (FR): `https://fr.hespress.com/feed` (491 characters, newest 1.2h)
5. TelQuel: `https://telquel.ma/feed` (345 characters, newest 5.4h)
6. Le Desk: `https://ledesk.ma/feed/` (332 characters, newest 4.2h)
7. Yabiladi: `https://www.yabiladi.com/rss/news.xml` (264 characters, newest 5.2h)
8. Challenge.ma: `https://www.challenge.ma/feed/` (177 characters, newest 58.2h)

**Mozambique** (3 feeds)

1. Club of Mozambique: `https://clubofmozambique.com/feed/` (355 characters, newest 31.2h)
2. Zitamar: `https://www.zitamar.com/feed/` (126 characters, newest 28h)
3. O País (Mozambique): `https://opais.co.mz/feed/` (492 characters, newest 5h)

**Myanmar** (4 feeds)

1. DVB: `https://english.dvb.no/feed/` (472 characters, newest 22.9h)
2. Myanmar Now: `https://myanmar-now.org/en/feed/` (152 characters, newest 35.6h, measured in the earlier run)
3. The Irrawaddy: `https://www.irrawaddy.com/feed` (138 characters, newest 32.7h)
4. The Guardian: `https://www.theguardian.com/world/myanmar/rss` (599 characters, newest 60.9h)

**Namibia** (3 feeds)

1. New Era: `https://neweralive.na/feed/` (459 characters, newest 33h)
2. The Namibian: `https://www.namibian.com.na/feed/` (453 characters, newest 3.6h)
3. Windhoek Observer: `https://www.observer24.com.na/feed/` (372 characters, newest 31h)

**Nepal** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/nepal/rss` (780 characters, newest 36.9h)
2. Onlinekhabar English: `https://english.onlinekhabar.com/feed` (497 characters, newest 7.6h)
3. The Himalayan Times: `https://thehimalayantimes.com/rssFeed/15` (183 characters, newest 35.5h)

**New Zealand** (3 feeds)

1. The Spinoff: `https://thespinoff.co.nz/feed` (6361 characters, newest 5.8h)
2. 1News: `https://www.1news.co.nz/arc/outboundfeeds/rss/?outputType=xml` (126 characters, newest 0.1h)
3. RNZ: `https://www.rnz.co.nz/rss/national.xml` (112 characters, newest 0.4h)

**Nicaragua** (4 feeds)

1. Divergentes: `https://www.divergentes.com/feed/` (478 characters, newest 7.2h)
2. Confidencial: `https://confidencial.digital/feed/` (449 characters, newest 1.3h)
3. Despacho 505: `https://www.despacho505.com/feed/` (322 characters, newest 4.9h)
4. Artículo 66: `https://www.articulo66.com/feed/` (184 characters, newest 0.7h)

**Nigeria** (9 feeds)

1. The Guardian: `https://www.theguardian.com/world/nigeria/rss` (680 characters, newest 37.9h)
2. Daily Trust: `https://dailytrust.com/feed/` (354 characters, newest 2.9h)
3. Premium Times (Nigeria): `https://www.premiumtimesng.com/feed` (312 characters, newest 2.1h)
4. Vanguard: `https://www.vanguardngr.com/feed/` (298 characters, newest 0.2h)
5. Channels TV: `https://www.channelstv.com/feed/` (252 characters, newest 0.5h)
6. Punch: `https://punchng.com/feed/` (243 characters, newest -0.3h)
7. BusinessDay (Nigeria): `https://businessday.ng/feed/` (211 characters, newest 0.9h)
8. ThisDay: `https://www.thisdaylive.com/index.php/feed/` (199 characters, newest 7.3h)
9. AllAfrica: `https://allafrica.com/tools/headlines/rdf/nigeria/headlines.rdf` (175 characters, newest 27.7h, measured in the earlier run)

**North Korea** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/north-korea/rss` (641 characters, newest 16.4h)
2. NK News: `https://www.nknews.org/feed/` (355 characters, newest 6.6h)
3. Daily NK: `https://www.dailynk.com/english/feed/` (345 characters, newest 25.1h)
4. 38 North: `https://www.38north.org/feed/` (184 characters, newest 32.4h)

**Norway** (4 feeds)

1. The Local Norway: `https://feeds.thelocal.com/rss/no` (199 characters, newest 31.5h)
2. NRK: `https://www.nrk.no/toppsaker.rss` (137 characters, newest 1.5h)
3. VG: `https://www.vg.no/rss/feed/` (104 characters, newest 1.3h)
4. Aftenposten: `https://www.aftenposten.no/rss` (94 characters, newest 0.9h)

**Pakistan** (4 feeds)

1. Dawn: `https://www.dawn.com/feeds/home` (3077 characters, newest 0.5h)
2. Business Recorder: `https://www.brecorder.com/feeds/latest-news` (1886 characters, newest 0.5h)
3. Geo News: `https://www.geo.tv/rss/1/1` (279 characters, newest 3h)
4. The Express Tribune: `https://tribune.com.pk/feed/pakistan` (83 characters, newest 11.6h)

**Palestine** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/palestinian-territories/rss` (630 characters, newest 15.9h)
2. +972 Magazine: `https://www.972mag.com/feed/` (267 characters, newest 29.4h)
3. Mondoweiss: `https://mondoweiss.net/feed/` (208 characters, newest 8.9h)

**Panama** (4 feeds)

1. Newsroom Panama: `https://newsroompanama.com/feed/` (212 characters, newest 8h)
2. TVN Panamá: `https://www.tvn-2.com/rss` (166 characters, newest 0h)
3. La Prensa (Panama): `https://www.prensa.com/arc/outboundfeeds/rss/?outputType=xml` (156 characters, newest 0.1h)
4. Critica: `https://www.critica.com.pa/rss.xml` (95 characters, newest 1.4h)

**Peru** (4 feeds)

1. Andina: `https://andina.pe/agencia/rss/0.xml` (319 characters, newest 0h)
2. La República (Peru): `https://larepublica.pe/rss/politica.xml` (216 characters, newest 0.9h)
3. El Comercio (Peru): `https://elcomercio.pe/arcio/rss/` (155 characters, newest 0.1h)
4. RPP: `https://rpp.pe/rss` (145 characters, newest 0h)

**Philippines** (5 feeds)

1. Inquirer: `https://newsinfo.inquirer.net/feed` (356 characters, newest -0.9h)
2. GMA News: `https://data.gmanetwork.com/gno/rss/news/feed.xml` (197 characters, newest 1.3h)
3. Philstar: `https://www.philstar.com/rss/headlines` (181 characters, newest 5.9h)
4. Rappler: `https://www.rappler.com/feed/` (150 characters, newest 11.9h)
5. The Guardian: `https://www.theguardian.com/world/philippines/rss` (629 characters, newest 67.9h)

**Poland** (6 feeds)

1. Notes from Poland: `https://notesfrompoland.com/feed/` (107 characters, newest 6.9h)
2. The Guardian: `https://www.theguardian.com/world/poland/rss` (607 characters, newest 53.3h)
3. Rzeczpospolita: `https://www.rp.pl/rss_main` (290 characters, newest 1.3h)
4. Onet: `https://wiadomosci.onet.pl/.feed` (247 characters, newest 0.2h)
5. Gazeta Wyborcza: `https://rss.gazeta.pl/pub/rss/najnowsze_wyborcza.xml` (205 characters, newest 4.5h)
6. TVN24: `https://tvn24.pl/najnowsze.xml` (199 characters, newest 1.5h)

**Portugal** (3 feeds)

1. Portugal Resident: `https://www.portugalresident.com/feed/` (289 characters, newest 0.7h)
2. The Portugal News: `https://www.theportugalnews.com/rss` (173 characters, newest 2.4h)
3. Público: `https://feeds.feedburner.com/PublicoRSS` (158 characters, newest 0.4h)

**Puerto Rico** (3 feeds)

1. Primera Hora: `https://www.primerahora.com/arc/outboundfeeds/rss/?outputType=xml` (104 characters, newest 1.5h)
2. El Nuevo Día: `https://www.elnuevodia.com/arc/outboundfeeds/rss/?outputType=xml` (96 characters, newest 0.3h)
3. Centro de Periodismo Investigativo: `https://periodismoinvestigativo.com/feed/` (186 characters, newest 83.9h)

**Romania** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/romania/rss` (548 characters, newest 78.4h)
2. G4Media: `https://www.g4media.ro/feed` (376 characters, newest 1.7h)
3. HotNews.ro: `https://www.hotnews.ro/rss` (348 characters, newest 2h)
4. Digi24: `https://www.digi24.ro/rss` (317 characters, newest 0.6h)

**Russia** (4 feeds)

1. Novaya Gazeta Europe: `https://novayagazeta.eu/feed/rss` (1716 characters, newest 7.1h)
2. The Guardian: `https://www.theguardian.com/world/russia/rss` (566 characters, newest 13h)
3. Meduza: `https://meduza.io/rss/en/all` (226 characters, newest 14.3h)
4. The Moscow Times: `https://www.themoscowtimes.com/rss/news` (129 characters, newest 3.8h)

**Rwanda** (4 feeds)

1. Taarifa: `https://taarifa.rw/feed/` (462 characters, newest 12.8h)
2. KT Press: `https://www.ktpress.rw/feed/` (306 characters, newest 6.9h)
3. AllAfrica: `https://allafrica.com/tools/headlines/rdf/rwanda/headlines.rdf` (217 characters, newest 28.4h, measured in the earlier run)
4. The Chronicles: `https://www.chronicles.rw/feed/` (435 characters, newest 51.8h)

**Senegal** (4 feeds)

1. AllAfrica: `https://allafrica.com/tools/headlines/rdf/senegal/headlines.rdf` (258 characters, newest 88.4h, measured in the earlier run)
2. APS (Senegal): `https://aps.sn/feed/` (451 characters, newest 0h)
3. Senego: `https://senego.com/feed` (177 characters, newest 0.3h)
4. Seneweb: `https://www.seneweb.com/feed` (144 characters, newest 0.5h)

**Serbia** (5 feeds)

1. RTS (Serbia): `https://www.rts.rs/page/stories/sr/rss.html` (236 characters, newest 0.9h)
2. Insajder: `https://insajder.net/feed` (232 characters, newest 0.4h)
3. Danas: `https://www.danas.rs/feed/` (208 characters, newest 0.1h)
4. N1: `https://n1info.rs/feed/` (150 characters, newest 0.1h)
5. Nova.rs: `https://nova.rs/feed/` (150 characters, newest 0.5h)

**Singapore** (4 feeds)

1. The Independent (Singapore): `https://theindependent.sg/feed/` (2722 characters, newest 2.4h)
2. Channel NewsAsia: `https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416` (148 characters, newest 6.6h)
3. The Business Times: `https://www.businesstimes.com.sg/rss/singapore` (100 characters, newest 32.9h)
4. The Straits Times: `https://www.straitstimes.com/news/singapore/rss.xml` (79 characters, newest 0.9h)

**Slovakia** (3 feeds)

1. Denník N: `https://dennikn.sk/feed/` (398 characters, newest 9.8h)
2. Pravda (Slovakia): `https://spravy.pravda.sk/rss/xml/` (280 characters, newest 1.4h)
3. Aktuality.sk: `https://www.aktuality.sk/rss/` (150 characters, newest 2.9h)

**South Africa** (8 feeds)

1. Mail & Guardian: `https://mg.co.za/rss/` (328 characters, newest 30.4h)
2. Daily Maverick: `https://www.dailymaverick.co.za/dmrss/` (210 characters, newest 8.2h)
3. AllAfrica: `https://allafrica.com/tools/headlines/rdf/southafrica/headlines.rdf` (208 characters, newest 27.8h, measured in the earlier run)
4. IOL: `https://iol.co.za/rss` (190 characters, newest 1.1h)
5. Moneyweb: `https://www.moneyweb.co.za/feed/` (123 characters, newest 19.9h)
6. The Citizen (South Africa): `https://www.citizen.co.za/feed/` (105 characters, newest 2.9h)
7. GroundUp: `https://groundup.org.za/sitenews/rss/` (71 characters, newest 4.6h)
8. The Guardian: `https://www.theguardian.com/world/southafrica/rss` (714 characters, newest 74h)

**South Korea** (3 feeds)

1. The Guardian: `https://www.theguardian.com/world/south-korea/rss` (587 characters, newest 13.9h)
2. The Korea Herald: `https://www.koreaherald.com/rss/newsAll` (500 characters, newest 13.8h)
3. Yonhap: `https://en.yna.co.kr/RSS/news.xml` (83 characters, newest 7.2h)

**Spain** (5 feeds)

1. The Guardian: `https://www.theguardian.com/world/spain/rss` (621 characters, newest 7.5h)
2. The Local Spain: `https://feeds.thelocal.com/rss/es` (202 characters, newest 15.6h)
3. The Olive Press: `https://www.theolivepress.es/feed/` (136 characters, newest 5.4h)
4. El Mundo: `https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml` (157 characters, newest 0.9h)
5. El País: `https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada` (153 characters, newest 0.1h)

**Sudan** (4 feeds)

1. Sudans Post: `https://www.sudanspost.com/feed/` (472 characters, newest 16.1h)
2. Darfur24: `https://www.darfur24.com/en/feed/` (428 characters, newest 10.2h)
3. Radio Dabanga: `https://www.dabangasudan.org/en/feed` (227 characters, newest 8.7h)
4. The Guardian: `https://www.theguardian.com/world/sudan/rss` (745 characters, newest 83.9h)

**Sweden** (5 feeds)

1. The Local Sweden: `https://feeds.thelocal.com/rss/se` (205 characters, newest 12.2h)
2. The Guardian: `https://www.theguardian.com/world/sweden/rss` (643 characters, newest 78.2h)
3. SVT: `https://www.svt.se/nyheter/rss.xml` (229 characters, newest 1.6h)
4. Expressen: `https://feeds.expressen.se/nyheter/` (176 characters, newest 0.2h)
5. Aftonbladet: `https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/` (75 characters, newest 0.6h)

**Switzerland** (7 feeds)

1. The Local Switzerland: `https://feeds.thelocal.com/rss/ch` (164 characters, newest 31.7h)
2. The Guardian: `https://www.theguardian.com/world/switzerland/rss` (605 characters, newest 65.9h)
3. Le Temps: `https://www.letemps.ch/articles.rss` (1388 characters, newest 1h)
4. RTS: `https://www.rts.ch/info/?format=rss/news` (265 characters, newest 1.2h)
5. NZZ: `https://www.nzz.ch/recent.rss` (181 characters, newest 1h)
6. Tages-Anzeiger: `https://www.tagesanzeiger.ch/rss.html` (170 characters, newest 0.5h)
7. SRF: `https://www.srf.ch/news/bnf/rss/1646` (113 characters, newest 0.4h)

**Syria** (5 feeds)

1. North Press Agency: `https://npasyria.com/en/feed/` (475 characters, newest 1.9h)
2. Syria Direct: `https://syriadirect.org/feed/` (309 characters, newest 34.1h)
3. Syrian Observer: `https://syrianobserver.com/feed` (255 characters, newest 36.2h)
4. Enab Baladi: `https://english.enabbaladi.net/feed/` (237 characters, newest 10.7h)
5. Levant24: `https://levant24.com/feed/` (158 characters, newest 8.2h)

**Tanzania** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/tanzania/rss` (629 characters, newest 24.7h)
2. Daily News (Tanzania): `https://dailynews.co.tz/feed/` (481 characters, newest 4.6h)
3. The Chanzo: `https://thechanzo.com/feed/` (261 characters, newest 11.8h)
4. AllAfrica: `https://allafrica.com/tools/headlines/rdf/tanzania/headlines.rdf` (240 characters, newest 27.8h, measured in the earlier run)

**Thailand** (4 feeds)

1. The Guardian: `https://www.theguardian.com/world/thailand/rss` (552 characters, newest 19.9h)
2. Thai Enquirer: `https://www.thaienquirer.com/feed/` (457 characters, newest 39.3h)
3. Khaosod English: `https://www.khaosodenglish.com/feed/` (456 characters, newest 9h)
4. Bangkok Post: `https://www.bangkokpost.com/rss/data/topstories.xml` (188 characters, newest 10.4h)

**The Gambia** (3 feeds)

1. The Alkamba Times: `https://www.alkambatimes.com/feed/` (476 characters, newest 4.1h)
2. Kerr Fatou: `https://www.kerrfatou.com/feed/` (365 characters, newest 1.7h)
3. The Standard (Gambia): `https://standard.gm/feed/` (356 characters, newest 36.4h)

**Tunisia** (5 feeds)

1. AllAfrica: `https://allafrica.com/tools/headlines/rdf/tunisia/headlines.rdf` (230 characters, newest 37.4h, measured in the earlier run)
2. Leaders: `https://www.leaders.com.tn/rss` (667 characters, newest 12.4h)
3. La Presse (Tunisia): `https://lapresse.tn/feed/` (509 characters, newest 0.1h)
4. Webdo: `https://www.webdo.tn/fr/feed/` (481 characters, newest 3.1h)
5. Kapitalis: `https://kapitalis.com/tunisie/feed/` (357 characters, newest 0.4h)

**Turkey** (6 feeds)

1. Turkish Minute: `https://www.turkishminute.com/feed/` (488 characters, newest 2.6h)
2. Hürriyet Daily News: `https://www.hurriyetdailynews.com/rss.aspx` (202 characters, newest 6.4h)
3. Daily Sabah: `https://www.dailysabah.com/rss/turkiye` (183 characters, newest 26.2h)
4. Bianet: `https://bianet.org/english/rss` (144 characters, newest 26.8h)
5. Anadolu Agency: `https://www.aa.com.tr/en/rss/default?cat=turkiye` (123 characters, newest 3.6h)
6. Medyascope: `https://medyascope.tv/feed/` (207 characters, newest 3.6h)

**Uganda** (5 feeds)

1. SoftPower: `https://www.softpower.ug/feed/` (499 characters, newest 8h)
2. The Independent (Uganda): `https://www.independent.co.ug/feed/` (482 characters, newest 6.9h)
3. PML Daily: `https://www.pmldaily.com/feed` (461 characters, newest 10.9h)
4. The Observer (Uganda): `https://observer.ug/feed` (453 characters, newest 7.1h)
5. AllAfrica: `https://allafrica.com/tools/headlines/rdf/uganda/headlines.rdf` (221 characters, newest 27.8h, measured in the earlier run)

**Ukraine** (5 feeds)

1. The Guardian: `https://www.theguardian.com/world/ukraine/rss` (557 characters, newest 13h)
2. Kyiv Post: `https://www.kyivpost.com/feed` (283 characters, newest 7.8h)
3. Ukrainska Pravda: `https://www.pravda.com.ua/eng/rss/` (166 characters, newest 4h)
4. Ukrinform: `https://www.ukrinform.net/rss/block-lastnews` (148 characters, newest 0.4h)
5. Euromaidan Press: `https://euromaidanpress.com/feed/` (133 characters, newest 0.4h)

**United Kingdom** (6 feeds)

1. The Guardian: `https://www.theguardian.com/uk-news/rss` (516 characters, newest 0.9h)
2. Daily Mirror: `https://www.mirror.co.uk/news/uk-news/?service=rss` (171 characters, newest 0.3h)
3. Channel 4 News: `https://www.channel4.com/news/uk/feed` (153 characters, newest 3.5h)
4. Sky News: `https://feeds.skynews.com/feeds/rss/uk.xml` (138 characters, newest 5.3h)
5. BBC: `https://feeds.bbci.co.uk/news/uk/rss.xml` (100 characters, newest 0.1h)
6. Evening Standard: `https://www.standard.co.uk/news/uk/rss` (91 characters, newest 3.2h)

**United States** (8 feeds)

1. The Guardian: `https://www.theguardian.com/us-news/rss` (619 characters, newest 0.5h)
2. PBS NewsHour: `https://www.pbs.org/newshour/feeds/rss/nation` (277 characters, newest 2.1h)
3. NPR: `https://feeds.npr.org/1003/rss.xml` (197 characters, newest 10.1h)
4. NBC News: `https://feeds.nbcnews.com/nbcnews/public/news` (182 characters, newest 0.1h)
5. LA Times: `https://www.latimes.com/nation/rss2.0.xml` (163 characters, newest 0.3h)
6. NYT: `https://rss.nytimes.com/services/xml/rss/nyt/US.xml` (160 characters, newest 0.2h)
7. ABC News: `https://abcnews.go.com/abcnews/usheadlines` (135 characters, newest 6.1h)
8. CBS News: `https://www.cbsnews.com/latest/rss/us` (134 characters, newest 0.4h)

**Uruguay** (3 feeds)

1. MercoPress: `https://en.mercopress.com/rss/uruguay` (320 characters, newest 4.5h, measured in the earlier run)
2. la diaria: `https://ladiaria.com.uy/feeds/articulos/` (512 characters, newest 0.3h)
3. Montevideo Portal: `https://www.montevideo.com.uy/anxml.aspx?59` (276 characters, newest 0.7h)

**Uzbekistan** (4 feeds)

1. Gazeta.uz: `https://www.gazeta.uz/en/rss/` (284 characters, newest 4.2h)
2. Daryo: `https://daryo.uz/en/rss` (181 characters, newest 3h)
3. UzDaily: `https://www.uzdaily.uz/en/rss` (138 characters, newest 1.1h)
4. Spot.uz: `https://www.spot.uz/rss/` (112 characters, newest 4.6h)

**Venezuela** (4 feeds)

1. Caracas Chronicles: `https://www.caracaschronicles.com/feed/` (120 characters, newest 11.9h)
2. The Guardian: `https://www.theguardian.com/world/venezuela/rss` (627 characters, newest 60.9h)
3. El Pitazo: `https://elpitazo.net/feed/` (483 characters, newest 0.9h)
4. Efecto Cocuyo: `https://efectococuyo.com/feed/` (115 characters, newest 2.2h)

**Zambia** (4 feeds)

1. Zambia Monitor: `https://www.zambiamonitor.com/feed/` (786 characters, newest 3.1h)
2. Lusaka Times: `https://www.lusakatimes.com/feed/` (391 characters, newest 2.6h)
3. AllAfrica: `https://allafrica.com/tools/headlines/rdf/zambia/headlines.rdf` (247 characters, newest 32.1h, measured in the earlier run)
4. Diggers: `https://diggers.news/feed/` (77 characters, newest 13.5h)

**Zimbabwe** (5 feeds)

1. NewZimbabwe: `https://www.newzimbabwe.com/feed/` (485 characters, newest 12.5h)
2. Nehanda Radio: `https://nehandaradio.com/feed/` (315 characters, newest 1.2h)
3. The Zimbabwe Independent: `https://www.theindependent.co.zw/feed/` (237 characters, newest 11.6h)
4. AllAfrica: `https://allafrica.com/tools/headlines/rdf/zimbabwe/headlines.rdf` (215 characters, newest 28.7h, measured in the earlier run)
5. ZimEye: `https://www.zimeye.net/feed/` (208 characters, newest 1h)
