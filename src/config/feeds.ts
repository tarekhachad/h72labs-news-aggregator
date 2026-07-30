import type { Source, Topic } from "@/types";

/**
 * Curated RSS feed per (topic, source). Not every source publishes a feed
 * for every topic, so this is a partial grid rather than a full grid.
 *
 * Every URL here was verified live (fetched and confirmed to return real
 * RSS/Atom XML with current items, not a 404/redirect/paywall page or a
 * stale/abandoned feed) during Phase 2 sourcing research, 2026-07-28.
 * Outlets that looked plausible but turned out dead, Cloudflare-blocked,
 * or frozen (e.g. Reuters, AP, WSJ Markets, CNN Business, Morocco World
 * News, L'Economiste, Goal.com, NBA.com, ATP/WTA official) were excluded
 * rather than guessed.
 *
 * Transfermarkt and The Athletic (European Football) added 2026-07-30,
 * same live-verification standard. Footmercato was checked too but has no
 * public RSS feed (no feed-discovery link, every common path 404s) — left
 * out rather than guessed at.
 */
export const FEEDS: Record<Topic, Partial<Record<Source, string>>> = {
  "Tech/AI": {
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    BBC: "http://feeds.bbci.co.uk/news/technology/rss.xml",
    TechCrunch: "https://techcrunch.com/feed/",
    "The Verge": "https://www.theverge.com/rss/index.xml",
    "Ars Technica": "https://feeds.arstechnica.com/arstechnica/index",
    Engadget: "https://www.engadget.com/rss.xml",
    Wired: "https://www.wired.com/feed/rss",
    ZDNet: "https://www.zdnet.com/news/rss.xml",
  },

  "US Politics": {
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
    "The Hill": "https://thehill.com/feed/",
    Politico: "https://rss.politico.com/politics-news.xml",
    Axios: "https://www.axios.com/feeds/feed.rss",
  },

  "Morocco Politics": {
    "Hespress (EN)": "https://en.hespress.com/politics/feed",
    "Hespress (FR)": "https://fr.hespress.com/politique/feed",
    Le360: "https://fr.le360.ma/arc/outboundfeeds/rss/category/politique/?outputType=xml",
  },

  "French Politics": {
    "Le Monde": "https://www.lemonde.fr/politique/rss_full.xml",
    "Le Figaro": "https://www.lefigaro.fr/rss/figaro_politique.xml",
    France24: "https://www.france24.com/en/rss",
    "RFI (EN)": "https://www.rfi.fr/en/rss",
    "RFI (FR)": "https://www.rfi.fr/fr/france/rss",
  },

  Geopolitics: {
    BBC: "http://feeds.bbci.co.uk/news/world/rss.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "The Guardian": "https://www.theguardian.com/world/rss",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    DW: "https://rss.dw.com/xml/rss-en-world",
  },

  Morocco: {
    "Hespress (EN)": "https://en.hespress.com/feed",
    "Hespress (FR)": "https://fr.hespress.com/feed",
    "The North Africa Post": "https://northafricapost.com/feed",
    Le360: "https://fr.le360.ma/arc/outboundfeeds/rss/?outputType=xml",
    Medias24: "https://medias24.com/feed",
    "Challenge.ma": "https://www.challenge.ma/feed",
  },

  "Morocco Finance": {
    Medias24: "https://medias24.com/?feed=rss2&cat=12575",
    "Le Boursier": "https://medias24.com/?feed=rss2&cat=14390",
    "Challenge.ma": "https://www.challenge.ma/bourse/feed",
    Le360: "https://fr.le360.ma/arc/outboundfeeds/rss/category/economie/?outputType=xml",
  },

  "US Finance": {
    CNBC: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    MarketWatch: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    "Yahoo Finance": "https://finance.yahoo.com/news/rssindex",
    Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
  },

  "World Finance": {
    "Financial Times": "https://www.ft.com/rss/home",
    "The Economist": "https://www.economist.com/finance-and-economics/rss.xml",
    Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
  },

  "European Football": {
    BBC: "http://feeds.bbci.co.uk/sport/football/rss.xml",
    "Sky Sports": "https://www.skysports.com/rss/11095",
    ESPN: "https://www.espn.com/espn/rss/soccer/news",
    "The Guardian": "https://www.theguardian.com/football/rss",
    "Football Italia": "https://www.football-italia.net/feed",
    Marca: "https://e00-marca.uecdn.es/rss/en/football.xml",
    "RMC Sport": "https://rmcsport.bfmtv.com/rss/football/",
    Kicker: "https://newsfeed.kicker.de/news/bundesliga",
    Transfermarkt: "https://www.transfermarkt.com/rss/news",
    "The Athletic": "https://www.nytimes.com/athletic/rss/football/",
  },

  Basketball: {
    ESPN: "https://www.espn.com/espn/rss/nba/news",
    "Yahoo Sports": "https://sports.yahoo.com/nba/rss/",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/nba/",
    RotoWire: "https://www.rotowire.com/rss/news.php?sport=nba",
    "Hoops Rumors": "https://www.hoopsrumors.com/feed",
  },

  Tennis: {
    ESPN: "https://www.espn.com/espn/rss/tennis/news",
    BBC: "http://feeds.bbci.co.uk/sport/tennis/rss.xml",
    Tennis365: "https://www.tennis365.com/feed/",
    "Tennis Majors": "https://www.tennismajors.com/feed/",
    UbiTennis: "https://www.ubitennis.com/feed/",
  },

  "American Football": {
    ESPN: "https://www.espn.com/espn/rss/nfl/news",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/nfl/",
    "Yahoo Sports": "https://sports.yahoo.com/nfl/rss/",
    "Pro Football Talk": "https://profootballtalk.nbcsports.com/feed/",
    "Sky Sports": "https://www.skysports.com/rss/12118",
  },
};
