import type { Source, Topic } from "@/types";

/**
 * Curated RSS feeds per (topic, source). Not every source publishes a feed
 * for every topic, so this is a partial grid rather than a full grid.
 *
 * A feed is listed only after `scripts/verify-feeds.mts` passed it live: it
 * parses as RSS or Atom with the same parser, User-Agent and timeout as
 * ingest.ts, its newest item is under four days old, every item has a title
 * and a link, its items carry real text (a median snippet of at least 40
 * characters, so not headlines alone), and the robots.txt of every host the
 * fetch passes through, redirects included, allows it.
 * A topic is offered only with at least 3 such feeds, and a source only with
 * at least one. Re-run the script before adding a feed, and after any change
 * here. `docs/(C) SOURCE_CATALOG.md` lists what shipped, and every topic and
 * outlet that was left out with the reason.
 *
 * Outlets whose terms or robots rules forbid automated collection (Reuters,
 * AP) are never added, and a block is never worked around.
 *
 * KEY ORDER IS MEANINGFUL. Within a topic, feeds run from strongest to
 * weakest, and a digest that reads only some of a topic's feeds fills from
 * the top after the reader's preferred outlets. Strongest means, in this
 * order: written in English (the clustering model is English-only, so other
 * languages group poorly with English coverage of the same story), then
 * fresh (an item within the last 48 hours, the furthest a digest looks
 * back), then the longest median snippet (more text for the card writer).
 */
export const FEEDS: Record<Topic, Partial<Record<Source, string>>> = {
  "Tech/AI": {
    "IEEE Spectrum": "https://spectrum.ieee.org/feeds/feed.rss",
    "The Verge": "https://www.theverge.com/rss/index.xml",
    "The Guardian": "https://www.theguardian.com/technology/rss",
    "MIT Technology Review": "https://www.technologyreview.com/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    TechCrunch: "https://techcrunch.com/feed/",
    Wired: "https://www.wired.com/feed/rss",
    BBC: "http://feeds.bbci.co.uk/news/technology/rss.xml",
    Engadget: "https://www.engadget.com/rss.xml",
    "Ars Technica": "https://feeds.arstechnica.com/arstechnica/index",
  },

  Cybersecurity: {
    BleepingComputer: "https://www.bleepingcomputer.com/feed/",
    "The Record": "https://therecord.media/feed",
    Wired: "https://www.wired.com/feed/category/security/latest/rss",
    "Dark Reading": "https://www.darkreading.com/rss.xml",
    "Ars Technica": "https://arstechnica.com/security/feed/",
    "The Guardian": "https://www.theguardian.com/technology/data-computer-security/rss",
  },

  "Consumer Tech & Gadgets": {
    "The Verge": "https://www.theverge.com/rss/tech/index.xml",
    "9to5Mac": "https://9to5mac.com/feed/",
    "Tom's Hardware": "https://www.tomshardware.com/feeds/all",
    Wired: "https://www.wired.com/feed/category/gear/latest/rss",
    Engadget: "https://www.engadget.com/rss.xml",
    "Android Authority": "https://www.androidauthority.com/feed/",
    "Ars Technica": "https://feeds.arstechnica.com/arstechnica/gadgets",
  },

  Gaming: {
    "The Guardian": "https://www.theguardian.com/games/rss",
    "The Verge": "https://www.theverge.com/rss/games/index.xml",
    IGN: "https://feeds.feedburner.com/ign/all",
    Kotaku: "https://kotaku.com/rss",
    "Ars Technica": "https://feeds.arstechnica.com/arstechnica/gaming",
    "PC Gamer": "https://www.pcgamer.com/rss/",
  },

  Space: {
    "The Guardian": "https://www.theguardian.com/science/space/rss",
    SpaceNews: "https://spacenews.com/feed/",
    "Phys.org": "https://phys.org/rss-feed/space-news/",
    "Ars Technica": "https://arstechnica.com/space/feed/",
    ScienceDaily: "https://www.sciencedaily.com/rss/space_time.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Space.xml",
  },

  Science: {
    "The Guardian": "https://www.theguardian.com/science/rss",
    "Phys.org": "https://phys.org/rss-feed/",
    ScienceDaily: "https://www.sciencedaily.com/rss/top/science.xml",
    NPR: "https://feeds.npr.org/1007/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml",
    "Scientific American": "http://rss.sciam.com/ScientificAmerican-Global",
    "Science (AAAS)": "https://www.science.org/rss/news_current.xml",
    BBC: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  },

  "Climate & Environment": {
    "The Guardian": "https://www.theguardian.com/environment/rss",
    "Inside Climate News": "https://insideclimatenews.org/feed/",
    DW: "https://rss.dw.com/xml/rss_en_environment",
    NPR: "https://feeds.npr.org/1025/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Climate.xml",
    Grist: "https://grist.org/feed/",
    "Carbon Brief": "https://www.carbonbrief.org/feed/",
  },

  "Energy Transition & Renewables": {
    "The Guardian": "https://www.theguardian.com/environment/renewableenergy/rss",
    CleanTechnica: "https://cleantechnica.com/feed/",
    "Canary Media": "https://www.canarymedia.com/rss.rss",
    Electrek: "https://electrek.co/feed/",
    InsideEVs: "https://insideevs.com/rss/news/all/",
    "Carbon Brief": "https://www.carbonbrief.org/feed/",
  },

  "Health & Medicine": {
    "The Guardian": "https://www.theguardian.com/society/health/rss",
    ScienceDaily: "https://www.sciencedaily.com/rss/health_medicine.xml",
    NPR: "https://feeds.npr.org/1128/rss.xml",
    "CBS News": "https://www.cbsnews.com/latest/rss/health",
    "STAT News": "https://www.statnews.com/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml",
    BBC: "https://feeds.bbci.co.uk/news/health/rss.xml",
  },

  "Biotech & Pharma": {
    "Phys.org": "https://phys.org/rss-feed/biology-news/biotechnology/",
    "Endpoints News": "https://endpts.com/feed/",
    "STAT News": "https://www.statnews.com/category/biotech/feed/",
  },

  "US Politics": {
    "The Guardian": "https://www.theguardian.com/us-news/us-politics/rss",
    "The Hill": "https://thehill.com/feed/",
    "PBS NewsHour": "https://www.pbs.org/newshour/feeds/rss/politics",
    NPR: "https://feeds.npr.org/1014/rss.xml",
    "CBS News": "https://www.cbsnews.com/latest/rss/politics",
    "NBC News": "https://feeds.nbcnews.com/nbcnews/public/politics",
    "LA Times": "https://www.latimes.com/politics/rss2.0.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
    "ABC News": "https://feeds.abcnews.com/abcnews/politicsheadlines",
    Politico: "https://rss.politico.com/politics-news.xml",
  },

  "Morocco Politics": {
    "Hespress (EN)": "https://en.hespress.com/politics/feed",
    "Hespress (FR)": "https://fr.hespress.com/politique/feed",
    TelQuel: "https://telquel.ma/categorie/maroc/politique/feed",
  },

  "French Politics": {
    "RFI (EN)": "https://www.rfi.fr/en/france/rss",
    France24: "https://www.france24.com/en/france/rss",
    "RFI (FR)": "https://www.rfi.fr/fr/france/rss",
    "Le Monde": "https://www.lemonde.fr/politique/rss_full.xml",
    "BFM TV": "https://www.bfmtv.com/rss/politique/",
    "Le Figaro": "https://www.lefigaro.fr/rss/figaro_politique.xml",
  },

  // Countries has no feeds of its own: each picked country reads from
  // COUNTRY_FEEDS in src/config/countries.ts.
  Countries: {},

  Geopolitics: {
    "The Guardian": "https://www.theguardian.com/world/rss",
    France24: "https://www.france24.com/en/rss",
    "PBS NewsHour": "https://www.pbs.org/newshour/feeds/rss/world",
    DW: "https://rss.dw.com/xml/rss-en-world",
    NPR: "https://feeds.npr.org/1004/rss.xml",
    Euronews: "https://www.euronews.com/rss?level=theme&name=news",
    "LA Times": "https://www.latimes.com/world-nation/rss2.0.xml",
    "Sky News": "https://feeds.skynews.com/feeds/rss/world.xml",
    "NBC News": "https://feeds.nbcnews.com/nbcnews/public/world",
    "CBS News": "https://www.cbsnews.com/latest/rss/world",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "The Diplomat": "https://thediplomat.com/feed/",
    "ABC News": "https://feeds.abcnews.com/abcnews/internationalheadlines",
    BBC: "http://feeds.bbci.co.uk/news/world/rss.xml",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "Foreign Policy": "https://foreignpolicy.com/feed/",
    "The Economist": "https://www.economist.com/international/rss.xml",
  },

  "UK Politics": {
    "The Guardian": "https://www.theguardian.com/politics/rss",
    "Sky News": "https://feeds.skynews.com/feeds/rss/politics.xml",
    BBC: "https://feeds.bbci.co.uk/news/politics/rss.xml",
    "The Economist": "https://www.economist.com/britain/rss.xml",
  },

  "European Union": {
    "The Guardian": "https://www.theguardian.com/world/eu/rss",
    France24: "https://www.france24.com/en/europe/rss",
    DW: "https://rss.dw.com/xml/rss-en-eu",
    "Politico Europe": "https://www.politico.eu/feed/",
    BBC: "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
    "The Economist": "https://www.economist.com/europe/rss.xml",
  },

  "Middle East": {
    "The Guardian": "https://www.theguardian.com/world/middleeast/rss",
    France24: "https://www.france24.com/en/middle-east/rss",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml",
    BBC: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
  },

  Africa: {
    "The Guardian": "https://www.theguardian.com/world/africa/rss",
    France24: "https://www.france24.com/en/africa/rss",
    "Mail & Guardian": "https://mg.co.za/rss/",
    "Premium Times (Nigeria)": "https://www.premiumtimesng.com/feed",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    "RFI (EN)": "https://www.rfi.fr/en/africa/rss",
    "Daily Maverick": "https://www.dailymaverick.co.za/dmrss/",
    DW: "https://rss.dw.com/xml/rss-en-africa",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml",
    BBC: "https://feeds.bbci.co.uk/news/world/africa/rss.xml",
    "The East African": "https://www.theeastafrican.co.ke/rss.xml",
    "Nation (Kenya)": "https://nation.africa/kenya/rss.xml",
    "Le Monde Afrique": "https://www.lemonde.fr/afrique/rss_full.xml",
  },

  "Asia-Pacific": {
    "The Guardian": "https://www.theguardian.com/world/asia-pacific/rss",
    "South China Morning Post": "https://www.scmp.com/rss/3/feed",
    France24: "https://www.france24.com/en/asia-pacific/rss",
    DW: "https://rss.dw.com/xml/rss-en-asia",
    "Channel NewsAsia": "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml",
    "Japan Times": "https://www.japantimes.co.jp/feed/",
    "The Diplomat": "https://thediplomat.com/feed/",
    BBC: "https://feeds.bbci.co.uk/news/world/asia/rss.xml",
    "The Economist": "https://www.economist.com/asia/rss.xml",
  },

  "Latin America": {
    "The Guardian": "https://www.theguardian.com/world/americas/rss",
    France24: "https://www.france24.com/en/americas/rss",
    MercoPress: "https://en.mercopress.com/rss",
    "Buenos Aires Times": "https://www.batimes.com.ar/feed",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml",
    BBC: "https://feeds.bbci.co.uk/news/world/latin_america/rss.xml",
    "The Economist": "https://www.economist.com/the-americas/rss.xml",
  },

  Elections: {
    France24: "https://www.france24.com/en/tag/elections/rss",
    "The Hill": "https://thehill.com/homenews/campaign/feed/",
    NPR: "https://feeds.npr.org/139482413/rss.xml",
  },

  Immigration: {
    "The Guardian": "https://www.theguardian.com/us-news/usimmigration/rss",
    InfoMigrants: "https://www.infomigrants.net/en/rss/all.xml",
    "CBS News": "https://www.cbsnews.com/latest/rss/immigration",
  },

  "Defense & Security": {
    "War on the Rocks": "https://warontherocks.com/feed/",
    "The Hill": "https://thehill.com/policy/defense/feed/",
    "The War Zone": "https://www.twz.com/feed",
    "Breaking Defense": "https://breakingdefense.com/feed/",
    "Defense News": "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml",
    Politico: "https://rss.politico.com/defense.xml",
  },

  "Human Rights": {
    "Human Rights Watch": "https://www.hrw.org/rss/news",
    "The Guardian": "https://www.theguardian.com/law/human-rights/rss",
    "Amnesty International": "https://www.amnesty.org/en/feed/",
  },

  "Morocco Finance": {
    "Hespress (EN)": "https://en.hespress.com/economy/feed",
    "The North Africa Post": "https://northafricapost.com/category/business/feed",
    "Hespress (FR)": "https://fr.hespress.com/economie/feed",
    TelQuel: "https://telquel.ma/categorie/economie/feed",
  },

  "US Finance": {
    Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
    NPR: "https://feeds.npr.org/1006/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
    Fortune: "https://fortune.com/feed/fortune-feeds/?id=3230629",
    CNBC: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "CBS News": "https://www.cbsnews.com/latest/rss/moneywatch",
    MarketWatch: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  },

  "World Finance": {
    "The Guardian": "https://www.theguardian.com/business/rss",
    Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
    DW: "https://rss.dw.com/xml/rss-en-bus",
    CNBC: "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    "Financial Times": "https://www.ft.com/global-economy?format=rss",
    BBC: "https://feeds.bbci.co.uk/news/business/rss.xml",
    "The Economist": "https://www.economist.com/finance-and-economics/rss.xml",
  },

  Economy: {
    "The Guardian": "https://www.theguardian.com/business/economics/rss",
    Bloomberg: "https://feeds.bloomberg.com/economics/news.rss",
    NPR: "https://feeds.npr.org/1017/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml",
    CNBC: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    BBC: "https://feeds.bbci.co.uk/news/business/rss.xml",
    "The Economist": "https://www.economist.com/finance-and-economics/rss.xml",
  },

  "Markets & Investing": {
    Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
    CNBC: "https://www.cnbc.com/id/15839069/device/rss/rss.html",
    "Financial Times": "https://www.ft.com/markets?format=rss",
  },

  "Personal Finance": {
    "The Guardian": "https://www.theguardian.com/money/rss",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/YourMoney.xml",
    CNBC: "https://www.cnbc.com/id/21324812/device/rss/rss.html",
    "CBS News": "https://www.cbsnews.com/latest/rss/moneywatch",
  },

  "Real Estate": {
    "The Guardian": "https://www.theguardian.com/money/property/rss",
    CNBC: "https://www.cnbc.com/id/10000115/device/rss/rss.html",
    HousingWire: "https://www.housingwire.com/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/RealEstate.xml",
  },

  "Energy & Oil": {
    "The Guardian": "https://www.theguardian.com/business/energy-industry/rss",
    "OilPrice.com": "https://oilprice.com/rss/main",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/EnergyEnvironment.xml",
    CNBC: "https://www.cnbc.com/id/19836768/device/rss/rss.html",
    Rigzone: "https://www.rigzone.com/news/rss/rigzone_latest.aspx",
  },

  Crypto: {
    Cointelegraph: "https://cointelegraph.com/rss",
    CoinDesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "The Block": "https://www.theblock.co/rss.xml",
  },

  Banking: {
    "Banking Dive": "https://www.bankingdive.com/feeds/news/",
    "Financial Times": "https://www.ft.com/banks?format=rss",
    "The Guardian": "https://www.theguardian.com/business/banking/rss",
  },

  "Retail & Consumer": {
    "The Guardian": "https://www.theguardian.com/business/retail/rss",
    Forbes: "https://www.forbes.com/retail/feed/",
    "Retail Dive": "https://www.retaildive.com/feeds/news/",
    CNBC: "https://www.cnbc.com/id/10000116/device/rss/rss.html",
    WWD: "https://wwd.com/business-news/feed/",
  },

  Automotive: {
    Autocar: "https://www.autocar.co.uk/rss",
    "The Verge": "https://www.theverge.com/rss/transportation/index.xml",
    "The Guardian": "https://www.theguardian.com/business/automotive-industry/rss",
    CNBC: "https://www.cnbc.com/id/10000101/device/rss/rss.html",
    Motor1: "https://www.motor1.com/rss/news/all/",
    InsideEVs: "https://insideevs.com/rss/news/all/",
    "Car and Driver": "https://www.caranddriver.com/rss/all.xml/",
  },

  Football: {
    "The Guardian": "https://www.theguardian.com/football/rss",
    Transfermarkt: "https://www.transfermarkt.com/rss/news",
    ESPN: "https://www.espn.com/espn/rss/soccer/news",
    BBC: "http://feeds.bbci.co.uk/sport/football/rss.xml",
    "The Athletic": "https://www.nytimes.com/athletic/rss/football/",
    "Football Italia": "https://www.football-italia.net/feed",
    Hesport: "https://www.hesport.com/feed",
    "RMC Sport": "https://rmcsport.bfmtv.com/rss/football/",
    Kicker: "https://newsfeed.kicker.de/news/bundesliga",
    Marca: "https://e00-marca.uecdn.es/rss/futbol/primera-division.xml",
  },

  Basketball: {
    "The Guardian": "https://www.theguardian.com/sport/nba/rss",
    "Hoops Rumors": "https://www.hoopsrumors.com/feed",
    RotoWire: "https://www.rotowire.com/rss/news.php?sport=nba",
    ESPN: "https://www.espn.com/espn/rss/nba/news",
    BBC: "https://feeds.bbci.co.uk/sport/basketball/rss.xml",
    "The Athletic": "https://www.nytimes.com/athletic/rss/nba/",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/nba/",
    "Yahoo Sports": "https://sports.yahoo.com/nba/rss/",
  },

  Tennis: {
    "The Guardian": "https://www.theguardian.com/sport/tennis/rss",
    "Tennis Majors": "https://www.tennismajors.com/feed/",
    Tennis365: "https://www.tennis365.com/feed/",
    UbiTennis: "https://www.ubitennis.com/feed/",
    ESPN: "https://www.espn.com/espn/rss/tennis/news",
    BBC: "http://feeds.bbci.co.uk/sport/tennis/rss.xml",
    "The Athletic": "https://www.nytimes.com/athletic/rss/tennis/",
    "L'Équipe": "https://dwh.lequipe.fr/api/edito/rss?path=/Tennis/",
  },

  "American Football": {
    "The Guardian": "https://www.theguardian.com/sport/nfl/rss",
    RotoWire: "https://www.rotowire.com/rss/news.php?sport=nfl",
    ESPN: "https://www.espn.com/espn/rss/nfl/news",
    "The Athletic": "https://www.nytimes.com/athletic/rss/nfl/",
    BBC: "https://feeds.bbci.co.uk/sport/american-football/rss.xml",
    "Pro Football Talk": "https://profootballtalk.nbcsports.com/feed/",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/nfl/",
    "Yahoo Sports": "https://sports.yahoo.com/nfl/rss/",
  },

  "Formula 1": {
    "The Guardian": "https://www.theguardian.com/sport/formulaone/rss",
    "Motorsport.com": "https://www.motorsport.com/rss/f1/news/",
    Autosport: "https://www.autosport.com/rss/f1/news/",
    ESPN: "https://www.espn.com/espn/rss/f1/news",
    "The Race": "https://www.the-race.com/feed/",
    BBC: "https://feeds.bbci.co.uk/sport/formula1/rss.xml",
  },

  Cricket: {
    "The Guardian": "https://www.theguardian.com/sport/cricket/rss",
    "Times of India": "https://timesofindia.indiatimes.com/rssfeeds/54829575.cms",
    BBC: "https://feeds.bbci.co.uk/sport/cricket/rss.xml",
    ESPNcricinfo: "https://www.espncricinfo.com/rss/content/story/feeds/0.xml",
    "The Hindu": "https://www.thehindu.com/sport/cricket/feeder/default.rss",
  },

  Rugby: {
    "The Guardian": "https://www.theguardian.com/sport/rugby-union/rss",
    RugbyPass: "https://www.rugbypass.com/feeds/rss/",
    BBC: "https://feeds.bbci.co.uk/sport/rugby-union/rss.xml",
    "RMC Sport": "https://rmcsport.bfmtv.com/rss/rugby/",
    "L'Équipe": "https://dwh.lequipe.fr/api/edito/rss?path=/Rugby/",
  },

  Golf: {
    "The Guardian": "https://www.theguardian.com/sport/golf/rss",
    ESPN: "https://www.espn.com/espn/rss/golf/news",
    "Yahoo Sports": "https://sports.yahoo.com/golf/rss/",
    BBC: "https://feeds.bbci.co.uk/sport/golf/rss.xml",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/golf/",
  },

  "Boxing & MMA": {
    "MMA Fighting": "https://www.mmafighting.com/rss/index.xml",
    "The Guardian": "https://www.theguardian.com/sport/boxing/rss",
    ESPN: "https://www.espn.com/espn/rss/boxing/news",
    BBC: "https://feeds.bbci.co.uk/sport/boxing/rss.xml",
  },

  Cycling: {
    BBC: "https://feeds.bbci.co.uk/sport/cycling/rss.xml",
    Cyclingnews: "https://www.cyclingnews.com/feeds.xml",
    "RMC Sport": "https://rmcsport.bfmtv.com/rss/cyclisme/",
    "L'Équipe": "https://dwh.lequipe.fr/api/edito/rss?path=/Cyclisme/",
  },

  Baseball: {
    "MLB Trade Rumors": "https://www.mlbtraderumors.com/feed",
    RotoWire: "https://www.rotowire.com/rss/news.php?sport=mlb",
    "The Athletic": "https://www.nytimes.com/athletic/rss/mlb/",
    ESPN: "https://www.espn.com/espn/rss/mlb/news",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/mlb/",
    "Yahoo Sports": "https://sports.yahoo.com/mlb/rss/",
  },

  "Olympics & Athletics": {
    "The Guardian": "https://www.theguardian.com/sport/athletics/rss",
    ESPN: "https://www.espn.com/espn/rss/oly/news",
    BBC: "https://feeds.bbci.co.uk/sport/athletics/rss.xml",
    "L'Équipe": "https://dwh.lequipe.fr/api/edito/rss?path=/Athletisme/",
  },

  "Film & TV": {
    "The Guardian": "https://www.theguardian.com/film/rss",
    Deadline: "https://deadline.com/feed/",
    Variety: "https://variety.com/feed/",
    IndieWire: "https://www.indiewire.com/feed/",
    "The Hollywood Reporter": "https://www.hollywoodreporter.com/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Movies.xml",
  },

  Music: {
    "The Guardian": "https://www.theguardian.com/music/rss",
    NME: "https://www.nme.com/news/music/feed",
    NPR: "https://feeds.npr.org/1039/rss.xml",
    "Rolling Stone": "https://www.rollingstone.com/music/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Music.xml",
    Pitchfork: "https://pitchfork.com/feed/feed-news/rss",
    Billboard: "https://www.billboard.com/feed/",
  },

  Books: {
    "The Guardian": "https://www.theguardian.com/books/rss",
    "Literary Hub": "https://lithub.com/feed/",
    NPR: "https://feeds.npr.org/1032/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Books.xml",
  },

  "Art & Design": {
    "The Guardian": "https://www.theguardian.com/artanddesign/rss",
    Dezeen: "https://www.dezeen.com/design/feed/",
    Designboom: "https://www.designboom.com/design/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/ArtandDesign.xml",
    "The Art Newspaper": "https://www.theartnewspaper.com/rss.xml",
    ARTnews: "https://www.artnews.com/feed/",
  },

  Architecture: {
    "The Guardian": "https://www.theguardian.com/artanddesign/architecture/rss",
    ArchDaily: "https://feeds.feedburner.com/Archdaily",
    Dezeen: "https://www.dezeen.com/architecture/feed/",
    Designboom: "https://www.designboom.com/architecture/feed/",
  },

  "Food & Drink": {
    Eater: "https://www.eater.com/rss/index.xml",
    "The Guardian": "https://www.theguardian.com/food/rss",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/DiningandWine.xml",
  },

  Travel: {
    Skift: "https://skift.com/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Travel.xml",
    CNBC: "https://www.cnbc.com/id/10000739/device/rss/rss.html",
    "Condé Nast Traveler": "https://www.cntraveler.com/feed/rss",
    "The Guardian": "https://www.theguardian.com/travel/rss",
  },

  Fashion: {
    "The Guardian": "https://www.theguardian.com/fashion/rss",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/FashionandStyle.xml",
    WWD: "https://wwd.com/feed/",
    Vogue: "https://www.vogue.com/feed/rss",
  },

  "Celebrity & Entertainment": {
    "The Guardian": "https://www.theguardian.com/culture/rss",
    "CBS News": "https://www.cbsnews.com/latest/rss/entertainment",
    "Sky News": "https://feeds.skynews.com/feeds/rss/entertainment.xml",
    "ABC News": "https://feeds.abcnews.com/abcnews/entertainmentheadlines",
    BBC: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
  },

  Education: {
    "The Guardian": "https://www.theguardian.com/education/rss",
    "Inside Higher Ed": "https://www.insidehighered.com/rss.xml",
    NPR: "https://feeds.npr.org/1013/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Education.xml",
    BBC: "https://feeds.bbci.co.uk/news/education/rss.xml",
  },

  Religion: {
    "The Guardian": "https://www.theguardian.com/world/religion/rss",
    "Religion News Service": "https://religionnews.com/feed/",
    NPR: "https://feeds.npr.org/1016/rss.xml",
  },

  "Health & Wellness": {
    "The Guardian": "https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss",
    ScienceDaily: "https://www.sciencedaily.com/rss/health_medicine/nutrition.xml",
    "NBC News": "https://feeds.nbcnews.com/nbcnews/public/health",
    "ABC News": "https://feeds.abcnews.com/abcnews/healthheadlines",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Well.xml",
  },

  "Law & Courts": {
    "The Guardian": "https://www.theguardian.com/law/rss",
    "The Hill": "https://thehill.com/regulation/court-battles/feed/",
    NPR: "https://feeds.npr.org/1070/rss.xml",
    Lawfare: "https://www.lawfaremedia.org/feeds/articles",
  },

  Crime: {
    "The Guardian": "https://www.theguardian.com/us-news/us-crime/rss",
    "CBS News": "https://www.cbsnews.com/latest/rss/crime",
    "The Marshall Project": "https://www.themarshallproject.org/rss/recent",
  },

  "Weather & Natural Disasters": {
    "The Guardian": "https://www.theguardian.com/world/extreme-weather/rss",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Weather.xml",
    ScienceDaily: "https://www.sciencedaily.com/rss/earth_climate/natural_disasters.xml",
  },

  "Media & Journalism": {
    "The Guardian": "https://www.theguardian.com/media/rss",
    "Nieman Lab": "https://www.niemanlab.org/feed/",
    Poynter: "https://www.poynter.org/feed/",
    "Press Gazette": "https://pressgazette.co.uk/feed/",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/MediaandAdvertising.xml",
  },
};
