import type { Source } from "@/types";

/**
 * The Countries topic: a reader picks countries inside it, and each picked
 * country is its own reading unit (src/lib/readingUnits.ts), with its own feed
 * slots and card limit. Only a country with at least 3 live-verified feeds is
 * offered, the same rule as topics.
 */
export const COUNTRIES_TOPIC = "Countries" as const;

/** Offered countries, in the order the picker lists them and a digest reads them. */
export const COUNTRIES: readonly string[] = [
  "Afghanistan",
  "Algeria",
  "Argentina",
  "Australia",
  "Austria",
  "Bangladesh",
  "Botswana",
  "Brazil",
  "Bulgaria",
  "Burkina Faso",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Chile",
  "China",
  "Costa Rica",
  "Côte d'Ivoire",
  "Croatia",
  "Cuba",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Dominican Republic",
  "DR Congo",
  "Egypt",
  "Ethiopia",
  "Finland",
  "France",
  "Germany",
  "Ghana",
  "Greece",
  "Guatemala",
  "Hong Kong",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Latvia",
  "Lebanon",
  "Libya",
  "Malaysia",
  "Mali",
  "Malta",
  "Mexico",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nepal",
  "New Zealand",
  "Nicaragua",
  "Nigeria",
  "North Korea",
  "Norway",
  "Pakistan",
  "Palestine",
  "Panama",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Puerto Rico",
  "Romania",
  "Russia",
  "Rwanda",
  "Senegal",
  "Serbia",
  "Singapore",
  "Slovakia",
  "South Africa",
  "South Korea",
  "Spain",
  "Sudan",
  "Sweden",
  "Switzerland",
  "Syria",
  "Tanzania",
  "Thailand",
  "The Gambia",
  "Tunisia",
  "Turkey",
  "Uganda",
  "Ukraine",
  "United Kingdom",
  "United States",
  "Uruguay",
  "Uzbekistan",
  "Venezuela",
  "Zambia",
  "Zimbabwe",
];

/**
 * Verified RSS feeds per country, strongest first: a digest fills a country's
 * feed slots in this key order after the reader's preferred outlets. Every
 * URL meets the bar in src/config/feeds.ts's header and
 * scripts/verify-feeds.mts.
 */
export const COUNTRY_FEEDS: Readonly<Record<string, Partial<Record<Source, string>>>> = {
  Afghanistan: {
    "Khaama Press": "https://www.khaama.com/feed/",
    "Hasht-e Subh": "https://8am.media/eng/feed/",
    KabulNow: "https://kabulnow.com/feed/",
    "Amu TV": "https://amu.tv/feed/",
  },

  Algeria: {
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/algeria/headlines.rdf",
    TSA: "https://www.tsa-algerie.com/feed/",
    Echorouk: "https://www.echoroukonline.com/feed",
    "Algérie360": "https://www.algerie360.com/feed/",
    "Le Monde": "https://www.lemonde.fr/algerie/rss_full.xml",
  },

  Argentina: {
    MercoPress: "https://en.mercopress.com/rss/argentina",
    "Buenos Aires Herald": "https://buenosairesherald.com/feed",
    "Buenos Aires Times": "https://www.batimes.com.ar/feed",
    "La Nación": "https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml",
    "Clarín": "https://www.clarin.com/rss/lo-ultimo/",
  },

  Australia: {
    "The Guardian": "https://www.theguardian.com/australia-news/rss",
    Crikey: "https://www.crikey.com.au/feed/",
    "ABC (Australia)": "https://www.abc.net.au/news/feed/51120/rss.xml",
  },

  Austria: {
    "The Local Austria": "https://feeds.thelocal.com/rss/at",
    "Die Presse": "https://www.diepresse.com/rss/",
    "Der Standard": "https://www.derstandard.at/rss",
    Kurier: "https://kurier.at/xml/rss",
  },

  Bangladesh: {
    "Dhaka Tribune": "https://www.dhakatribune.com/feed/",
    "The Business Standard": "https://www.tbsnews.net/top-news/rss.xml",
    "The Guardian": "https://www.theguardian.com/world/bangladesh/rss",
  },

  Botswana: {
    "Sunday Standard": "https://www.sundaystandard.info/feed/",
    "Weekend Post": "https://www.weekendpost.co.bw/feed",
    "The Botswana Gazette": "https://www.thegazette.news/feed/",
  },

  Brazil: {
    "Agência Brasil": "https://agenciabrasil.ebc.com.br/en/rss/ultimasnoticias/feed.xml",
    "The Guardian": "https://www.theguardian.com/world/brazil/rss",
    "The Rio Times": "https://www.riotimesonline.com/feed/",
    G1: "https://g1.globo.com/rss/g1/",
    "Folha de S.Paulo": "https://feeds.folha.uol.com.br/emcimadahora/rss091.xml",
  },

  Bulgaria: {
    BTA: "https://www.bta.bg/en/rss/free",
    Novinite: "https://www.novinite.com/services/news_rdf.php",
    Mediapool: "https://www.mediapool.bg/rss/",
    Dnevnik: "https://www.dnevnik.bg/rss/",
  },

  "Burkina Faso": {
    "Lefaso.net": "https://lefaso.net/spip.php?page=backend",
    Burkina24: "https://burkina24.com/feed/",
    Sidwaya: "https://www.sidwaya.info/feed/",
  },

  Cambodia: {
    "Phnom Penh Post": "https://www.phnompenhpost.com/rss",
    "Khmer Times": "https://www.khmertimeskh.com/feed/",
    "CamboJA News": "https://cambojanews.com/feed/",
  },

  Cameroon: {
    "Mimi Mefo Info": "https://mimimefoinfos.com/feed/",
    "Cameroon News Agency": "https://cameroonnewsagency.com/feed/",
    "Data Cameroon": "https://datacameroon.com/feed/",
    "Actu Cameroun": "https://actucameroun.com/feed/",
  },

  Canada: {
    "Global News": "https://globalnews.ca/canada/feed/",
    "National Post": "https://nationalpost.com/category/news/canada/feed",
    "The Globe and Mail": "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/canada/",
    "The Guardian": "https://www.theguardian.com/world/canada/rss",
    "Radio-Canada": "https://ici.radio-canada.ca/rss/4159",
  },

  Chile: {
    MercoPress: "https://en.mercopress.com/rss/chile",
    Cooperativa: "https://www.cooperativa.cl/noticias/site/tax/port/all/rss_3___1.xml",
    "La Tercera": "https://www.latercera.com/arc/outboundfeeds/rss/?outputType=xml",
  },

  China: {
    "The Guardian": "https://www.theguardian.com/world/china/rss",
    "South China Morning Post": "https://www.scmp.com/rss/4/feed",
    "China Digital Times": "https://chinadigitaltimes.net/feed/",
    BBC: "https://feeds.bbci.co.uk/news/world/asia/china/rss.xml",
  },

  "Costa Rica": {
    "The Tico Times": "https://ticotimes.net/feed",
    Delfino: "https://delfino.cr/feed",
    "La Nación (Costa Rica)": "https://www.nacion.com/arc/outboundfeeds/rss/?outputType=xml",
  },

  "Côte d'Ivoire": {
    Linfodrome: "https://www.linfodrome.com/rss",
    Connectionivoirienne: "https://www.connectionivoirienne.net/feed/",
    Ivoirematin: "https://www.ivoirematin.com/feed/",
  },

  Croatia: {
    "Total Croatia News": "https://total-croatia-news.com/feed/",
    "Croatia Week": "https://www.croatiaweek.com/feed/",
    "Index.hr": "https://www.index.hr/rss",
  },

  Cuba: {
    "The Guardian": "https://www.theguardian.com/world/cuba/rss",
    "Havana Times": "https://havanatimes.org/feed/",
    "Diario de Cuba": "https://diariodecuba.com/rss.xml",
    "14ymedio": "https://www.14ymedio.com/rss/",
  },

  Cyprus: {
    "Financial Mirror": "https://www.financialmirror.com/feed/",
    "In-Cyprus": "https://in-cyprus.philenews.com/feed/",
    "Cyprus Mail": "https://cyprus-mail.com/category/cyprus/feed/",
    Politis: "https://politis.com.cy/feed/",
  },

  "Czech Republic": {
    "Expats.cz": "https://www.expats.cz/feed",
    "Radio Prague International": "https://english.radio.cz/rcz-rss/en",
    "ČT24": "https://ct24.ceskatelevize.cz/rss/hlavni-zpravy",
    iRozhlas: "https://www.irozhlas.cz/rss/irozhlas",
    "Novinky.cz": "https://www.novinky.cz/rss",
  },

  Denmark: {
    "The Copenhagen Post": "https://cphpost.dk/feed/",
    "The Local Denmark": "https://feeds.thelocal.com/rss/dk",
    Politiken: "https://politiken.dk/rss/senestenyt.rss",
  },

  "Dominican Republic": {
    "Dominican Today": "https://dominicantoday.com/feed/",
    "El Nuevo Diario (DR)": "https://elnuevodiario.com.do/feed/",
    "N Digital": "https://n.com.do/feed/",
  },

  "DR Congo": {
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/congo_kinshasa/headlines.rdf",
    "Actualite.cd": "https://actualite.cd/feed",
    "Zoom Eco": "https://zoom-eco.net/feed/",
    "Politico.cd": "https://www.politico.cd/feed/",
    "Congo Indépendant": "https://www.congoindependant.com/feed/",
  },

  Egypt: {
    "Egyptian Streets": "https://egyptianstreets.com/feed/",
    "The Guardian": "https://www.theguardian.com/world/egypt/rss",
    "Mada Masr": "https://www.madamasr.com/en/feed/",
    "Egypt Independent": "https://www.egyptindependent.com/feed/",
    "Daily News Egypt": "https://www.dailynewsegypt.com/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/egypt/headlines.rdf",
  },

  Ethiopia: {
    "Ethiopia Observer": "https://www.ethiopiaobserver.com/feed/",
    "Capital Ethiopia": "https://www.capitalethiopia.com/feed/",
    Fana: "https://www.fanabc.com/english/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/ethiopia/headlines.rdf",
    "Ethiopia Insight": "https://www.ethiopia-insight.com/feed/",
  },

  Finland: {
    "Helsinki Times": "https://www.helsinkitimes.fi/?format=feed&type=rss",
    "The Guardian": "https://www.theguardian.com/world/finland/rss",
    Yle: "https://yle.fi/rss/uutiset/paauutiset",
    "Helsingin Sanomat": "https://www.hs.fi/rss/tuoreimmat.xml",
  },

  France: {
    "The Guardian": "https://www.theguardian.com/world/france/rss",
    "RFI (EN)": "https://www.rfi.fr/en/france/rss",
    "The Local France": "https://feeds.thelocal.com/rss/fr",
    "Le Monde": "https://www.lemonde.fr/politique/rss_full.xml",
    "Le Figaro": "https://www.lefigaro.fr/rss/figaro_actualites.xml",
    "BFM TV": "https://www.bfmtv.com/rss/news-24-7/",
  },

  Germany: {
    "The Guardian": "https://www.theguardian.com/world/germany/rss",
    DW: "https://rss.dw.com/rdf/rss-en-ger",
    "The Local Germany": "https://feeds.thelocal.com/rss/de",
    Tagesschau: "https://www.tagesschau.de/xml/rss2",
  },

  Ghana: {
    "Graphic Online": "https://www.graphic.com.gh/news/general-news?format=feed&type=rss",
    MyJoyOnline: "https://www.myjoyonline.com/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/ghana/headlines.rdf",
    "3News": "https://3news.com/feed/",
    "The Guardian": "https://www.theguardian.com/world/ghana/rss",
  },

  Greece: {
    "The Guardian": "https://www.theguardian.com/world/greece/rss",
    "Greek City Times": "https://greekcitytimes.com/feed/",
    Kathimerini: "https://www.ekathimerini.com/infeeds/rss/nx-rss-feed.xml",
    "To Vima": "https://www.tovima.com/feed/",
  },

  Guatemala: {
    ConCriterio: "https://concriterio.gt/feed/",
    "Plaza Pública": "https://www.plazapublica.com.gt/feed",
    "Agencia Ocote": "https://www.agenciaocote.com/feed/",
    "Prensa Libre": "https://www.prensalibre.com/feed/",
    "República (Guatemala)": "https://republica.gt/feed/",
  },

  "Hong Kong": {
    RTHK: "https://rthk.hk/rthk/news/rss/e_expressnews_elocal.xml",
    "The Witness": "https://thewitnesshk.com/feed/",
    "South China Morning Post": "https://www.scmp.com/rss/2/feed",
    "Hong Kong Free Press": "https://hongkongfp.com/feed/",
  },

  Hungary: {
    "Hungary Today": "https://hungarytoday.hu/feed/",
    "Hungarian Conservative": "https://www.hungarianconservative.com/feed/",
    "Daily News Hungary": "https://dailynewshungary.com/feed/",
    "Budapest Times": "https://www.budapesttimes.hu/feed/",
    HVG: "https://hvg.hu/rss",
    "444.hu": "https://444.hu/feed",
    "Index.hu": "https://index.hu/24ora/rss/",
  },

  Iceland: {
    "RÚV English": "https://www.ruv.is/rss/english",
    Grapevine: "https://grapevine.is/feed/",
    "Iceland Review": "https://www.icelandreview.com/feed/",
    "Iceland Monitor": "https://icelandmonitor.mbl.is/rss/",
  },

  India: {
    "The Guardian": "https://www.theguardian.com/world/india/rss",
    NDTV: "https://feeds.feedburner.com/ndtvnews-india-news",
    "Hindustan Times": "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",
    "The Hindu": "https://www.thehindu.com/news/national/feeder/default.rss",
    Scroll: "https://feeds.feedburner.com/ScrollinArticles.rss",
  },

  Indonesia: {
    Antara: "https://en.antaranews.com/rss/news.xml",
    "The Guardian": "https://www.theguardian.com/world/indonesia/rss",
    Republika: "https://www.republika.co.id/rss",
    "CNN Indonesia": "https://www.cnnindonesia.com/nasional/rss",
  },

  Iran: {
    "The Guardian": "https://www.theguardian.com/world/iran/rss",
    "Amwaj.media": "https://amwaj.media/rss",
    IranWire: "https://iranwire.com/en/feed/",
  },

  Iraq: {
    "Iraqi News": "https://www.iraqinews.com/feed/",
    Kurdistan24: "https://www.kurdistan24.net/en/rss.xml",
    "The Guardian": "https://www.theguardian.com/world/iraq/rss",
  },

  Ireland: {
    "The Guardian": "https://www.theguardian.com/world/ireland/rss",
    "RTÉ": "https://www.rte.ie/feeds/rss/?index=/news/",
    "Irish Examiner": "https://www.irishexaminer.com/feed/35-top_news.xml",
    "The Irish Times": "https://www.irishtimes.com/arc/outboundfeeds/feed-irish-news/?outputType=xml",
  },

  Israel: {
    "The Guardian": "https://www.theguardian.com/world/israel/rss",
    "Israel Hayom": "https://www.israelhayom.com/feed/",
    Haaretz: "https://www.haaretz.com/srv/haaretz-latest-headlines",
    "The Jerusalem Post": "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    JNS: "https://www.jns.org/feed/",
  },

  Italy: {
    ANSA: "https://www.ansa.it/english/news/english_nr_rss.xml",
    "The Guardian": "https://www.theguardian.com/world/italy/rss",
    Decode39: "https://decode39.com/feed/",
    "The Local Italy": "https://feeds.thelocal.com/rss/it",
    "la Repubblica": "https://www.repubblica.it/rss/homepage/rss2.0.xml",
  },

  Japan: {
    "Nippon.com": "https://www.nippon.com/en/feed/",
    "Japan Today": "https://japantoday.com/feed",
    "The Mainichi": "https://mainichi.jp/english/rss/etc/english_latest.rss",
    "Japan Times": "https://www.japantimes.co.jp/feed/",
    "The Guardian": "https://www.theguardian.com/world/japan/rss",
  },

  Jordan: {
    "Roya News": "https://en.royanews.tv/rss",
    "Jordan News": "https://www.jordannews.jo/rss",
    "7iber": "https://www.7iber.com/feed/",
  },

  Kazakhstan: {
    "The Astana Times": "https://astanatimes.com/feed/",
    Kursiv: "https://kz.kursiv.media/en/feed/",
    Tengrinews: "https://tengrinews.kz/news.rss",
  },

  Kenya: {
    KBC: "https://www.kbc.co.ke/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/kenya/headlines.rdf",
    "Capital FM (Kenya)": "https://www.capitalfm.co.ke/news/feed",
    Tuko: "https://www.tuko.co.ke/rss/all.rss",
    "Kenyans.co.ke": "https://www.kenyans.co.ke/feeds/news",
    "The Standard (Kenya)": "https://www.standardmedia.co.ke/rss/headlines.php",
    "The Guardian": "https://www.theguardian.com/world/kenya/rss",
  },

  Latvia: {
    LSM: "https://eng.lsm.lv/rss/",
    "Baltic News Network": "https://bnn-news.com/feed",
    TVNET: "https://www.tvnet.lv/rss",
    "LSM (Latvian)": "https://www.lsm.lv/rss/",
    "Delfi (Latvia)": "https://www.delfi.lv/rss/index.xml",
  },

  Lebanon: {
    "Beirut Today": "https://beirut-today.com/feed/",
    The961: "https://www.the961.com/feed/",
    "NOW Lebanon": "https://nowlebanon.com/feed/",
    Annahar: "https://www.annahar.com/rss",
  },

  Libya: {
    "The Guardian": "https://www.theguardian.com/world/libya/rss",
    "Libya Update": "https://libyaupdate.com/feed/",
    "Libya Review": "https://libyareview.com/feed/",
    "Libya Herald": "https://libyaherald.com/feed/",
  },

  Malaysia: {
    "Free Malaysia Today": "https://www.freemalaysiatoday.com/feed/",
    "Malay Mail": "https://www.malaymail.com/feed/rss/malaysia",
    Malaysiakini: "https://www.malaysiakini.com/rss/en/news.rss",
    "The Guardian": "https://www.theguardian.com/world/malaysia/rss",
  },

  Mali: {
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/mali/headlines.rdf",
    "Studio Tamani": "https://www.studiotamani.org/feed/",
    "Mali Actu": "https://maliactu.net/feed/",
    "Le Monde": "https://www.lemonde.fr/mali/rss_full.xml",
  },

  Malta: {
    "Lovin Malta": "https://lovinmalta.com/feed/",
    "The Shift": "https://theshiftnews.com/feed/",
    Newsbook: "https://newsbook.com.mt/en/feed/",
  },

  Mexico: {
    "The Guardian": "https://www.theguardian.com/world/mexico/rss",
    "Mexico News Daily": "https://mexiconewsdaily.com/feed/",
    "La Jornada": "https://www.jornada.com.mx/rss/edicion.xml",
    "El Financiero": "https://www.elfinanciero.com.mx/arc/outboundfeeds/rss/?outputType=xml",
  },

  Morocco: {
    "Hespress (EN)": "https://en.hespress.com/feed",
    "The North Africa Post": "https://northafricapost.com/feed",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/morocco/headlines.rdf",
    "Hespress (FR)": "https://fr.hespress.com/feed",
    TelQuel: "https://telquel.ma/feed",
    "Le Desk": "https://ledesk.ma/feed/",
    Yabiladi: "https://www.yabiladi.com/rss/news.xml",
    "Challenge.ma": "https://www.challenge.ma/feed/",
  },

  Mozambique: {
    "Club of Mozambique": "https://clubofmozambique.com/feed/",
    Zitamar: "https://www.zitamar.com/feed/",
    "O País (Mozambique)": "https://opais.co.mz/feed/",
  },

  Myanmar: {
    DVB: "https://english.dvb.no/feed/",
    "Myanmar Now": "https://myanmar-now.org/en/feed/",
    "The Irrawaddy": "https://www.irrawaddy.com/feed",
    "The Guardian": "https://www.theguardian.com/world/myanmar/rss",
  },

  Namibia: {
    "New Era": "https://neweralive.na/feed/",
    "The Namibian": "https://www.namibian.com.na/feed/",
    "Windhoek Observer": "https://www.observer24.com.na/feed/",
  },

  Nepal: {
    "The Guardian": "https://www.theguardian.com/world/nepal/rss",
    "Onlinekhabar English": "https://english.onlinekhabar.com/feed",
    "The Himalayan Times": "https://thehimalayantimes.com/rssFeed/15",
  },

  "New Zealand": {
    "The Spinoff": "https://thespinoff.co.nz/feed",
    "1News": "https://www.1news.co.nz/arc/outboundfeeds/rss/?outputType=xml",
    RNZ: "https://www.rnz.co.nz/rss/national.xml",
  },

  Nicaragua: {
    Divergentes: "https://www.divergentes.com/feed/",
    Confidencial: "https://confidencial.digital/feed/",
    "Despacho 505": "https://www.despacho505.com/feed/",
    "Artículo 66": "https://www.articulo66.com/feed/",
  },

  Nigeria: {
    "The Guardian": "https://www.theguardian.com/world/nigeria/rss",
    "Daily Trust": "https://dailytrust.com/feed/",
    "Premium Times (Nigeria)": "https://www.premiumtimesng.com/feed",
    Vanguard: "https://www.vanguardngr.com/feed/",
    "Channels TV": "https://www.channelstv.com/feed/",
    Punch: "https://punchng.com/feed/",
    "BusinessDay (Nigeria)": "https://businessday.ng/feed/",
    ThisDay: "https://www.thisdaylive.com/index.php/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/nigeria/headlines.rdf",
  },

  "North Korea": {
    "The Guardian": "https://www.theguardian.com/world/north-korea/rss",
    "NK News": "https://www.nknews.org/feed/",
    "Daily NK": "https://www.dailynk.com/english/feed/",
    "38 North": "https://www.38north.org/feed/",
  },

  Norway: {
    "The Local Norway": "https://feeds.thelocal.com/rss/no",
    NRK: "https://www.nrk.no/toppsaker.rss",
    VG: "https://www.vg.no/rss/feed/",
    Aftenposten: "https://www.aftenposten.no/rss",
  },

  Pakistan: {
    Dawn: "https://www.dawn.com/feeds/home",
    "Business Recorder": "https://www.brecorder.com/feeds/latest-news",
    "Geo News": "https://www.geo.tv/rss/1/1",
    "The Express Tribune": "https://tribune.com.pk/feed/pakistan",
  },

  Palestine: {
    "The Guardian": "https://www.theguardian.com/world/palestinian-territories/rss",
    "+972 Magazine": "https://www.972mag.com/feed/",
    Mondoweiss: "https://mondoweiss.net/feed/",
  },

  Panama: {
    "Newsroom Panama": "https://newsroompanama.com/feed/",
    "TVN Panamá": "https://www.tvn-2.com/rss",
    "La Prensa (Panama)": "https://www.prensa.com/arc/outboundfeeds/rss/?outputType=xml",
    Critica: "https://www.critica.com.pa/rss.xml",
  },

  Peru: {
    Andina: "https://andina.pe/agencia/rss/0.xml",
    "La República (Peru)": "https://larepublica.pe/rss/politica.xml",
    "El Comercio (Peru)": "https://elcomercio.pe/arcio/rss/",
    RPP: "https://rpp.pe/rss",
  },

  Philippines: {
    Inquirer: "https://newsinfo.inquirer.net/feed",
    "GMA News": "https://data.gmanetwork.com/gno/rss/news/feed.xml",
    Philstar: "https://www.philstar.com/rss/headlines",
    Rappler: "https://www.rappler.com/feed/",
    "The Guardian": "https://www.theguardian.com/world/philippines/rss",
  },

  Poland: {
    "Notes from Poland": "https://notesfrompoland.com/feed/",
    "The Guardian": "https://www.theguardian.com/world/poland/rss",
    Rzeczpospolita: "https://www.rp.pl/rss_main",
    Onet: "https://wiadomosci.onet.pl/.feed",
    "Gazeta Wyborcza": "https://rss.gazeta.pl/pub/rss/najnowsze_wyborcza.xml",
    TVN24: "https://tvn24.pl/najnowsze.xml",
  },

  Portugal: {
    "Portugal Resident": "https://www.portugalresident.com/feed/",
    "The Portugal News": "https://www.theportugalnews.com/rss",
    "Público": "https://feeds.feedburner.com/PublicoRSS",
  },

  "Puerto Rico": {
    "Primera Hora": "https://www.primerahora.com/arc/outboundfeeds/rss/?outputType=xml",
    "El Nuevo Día": "https://www.elnuevodia.com/arc/outboundfeeds/rss/?outputType=xml",
    "Centro de Periodismo Investigativo": "https://periodismoinvestigativo.com/feed/",
  },

  Romania: {
    "The Guardian": "https://www.theguardian.com/world/romania/rss",
    G4Media: "https://www.g4media.ro/feed",
    "HotNews.ro": "https://www.hotnews.ro/rss",
    Digi24: "https://www.digi24.ro/rss",
  },

  Russia: {
    "Novaya Gazeta Europe": "https://novayagazeta.eu/feed/rss",
    "The Guardian": "https://www.theguardian.com/world/russia/rss",
    Meduza: "https://meduza.io/rss/en/all",
    "The Moscow Times": "https://www.themoscowtimes.com/rss/news",
  },

  Rwanda: {
    Taarifa: "https://taarifa.rw/feed/",
    "KT Press": "https://www.ktpress.rw/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/rwanda/headlines.rdf",
    "The Chronicles": "https://www.chronicles.rw/feed/",
  },

  Senegal: {
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/senegal/headlines.rdf",
    "APS (Senegal)": "https://aps.sn/feed/",
    Senego: "https://senego.com/feed",
    Seneweb: "https://www.seneweb.com/feed",
  },

  Serbia: {
    "RTS (Serbia)": "https://www.rts.rs/page/stories/sr/rss.html",
    Insajder: "https://insajder.net/feed",
    Danas: "https://www.danas.rs/feed/",
    N1: "https://n1info.rs/feed/",
    "Nova.rs": "https://nova.rs/feed/",
  },

  Singapore: {
    "The Independent (Singapore)": "https://theindependent.sg/feed/",
    "Channel NewsAsia": "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416",
    "The Business Times": "https://www.businesstimes.com.sg/rss/singapore",
    "The Straits Times": "https://www.straitstimes.com/news/singapore/rss.xml",
  },

  Slovakia: {
    "Denník N": "https://dennikn.sk/feed/",
    "Pravda (Slovakia)": "https://spravy.pravda.sk/rss/xml/",
    "Aktuality.sk": "https://www.aktuality.sk/rss/",
  },

  "South Africa": {
    "Mail & Guardian": "https://mg.co.za/rss/",
    "Daily Maverick": "https://www.dailymaverick.co.za/dmrss/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/southafrica/headlines.rdf",
    IOL: "https://iol.co.za/rss",
    Moneyweb: "https://www.moneyweb.co.za/feed/",
    "The Citizen (South Africa)": "https://www.citizen.co.za/feed/",
    GroundUp: "https://groundup.org.za/sitenews/rss/",
    "The Guardian": "https://www.theguardian.com/world/southafrica/rss",
  },

  "South Korea": {
    "The Guardian": "https://www.theguardian.com/world/south-korea/rss",
    "The Korea Herald": "https://www.koreaherald.com/rss/newsAll",
    Yonhap: "https://en.yna.co.kr/RSS/news.xml",
  },

  Spain: {
    "The Guardian": "https://www.theguardian.com/world/spain/rss",
    "The Local Spain": "https://feeds.thelocal.com/rss/es",
    "The Olive Press": "https://www.theolivepress.es/feed/",
    "El Mundo": "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml",
    "El País": "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada",
  },

  Sudan: {
    "Sudans Post": "https://www.sudanspost.com/feed/",
    Darfur24: "https://www.darfur24.com/en/feed/",
    "Radio Dabanga": "https://www.dabangasudan.org/en/feed",
    "The Guardian": "https://www.theguardian.com/world/sudan/rss",
  },

  Sweden: {
    "The Local Sweden": "https://feeds.thelocal.com/rss/se",
    "The Guardian": "https://www.theguardian.com/world/sweden/rss",
    SVT: "https://www.svt.se/nyheter/rss.xml",
    Expressen: "https://feeds.expressen.se/nyheter/",
    Aftonbladet: "https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/",
  },

  Switzerland: {
    "The Local Switzerland": "https://feeds.thelocal.com/rss/ch",
    "The Guardian": "https://www.theguardian.com/world/switzerland/rss",
    "Le Temps": "https://www.letemps.ch/articles.rss",
    RTS: "https://www.rts.ch/info/?format=rss/news",
    NZZ: "https://www.nzz.ch/recent.rss",
    "Tages-Anzeiger": "https://www.tagesanzeiger.ch/rss.html",
    SRF: "https://www.srf.ch/news/bnf/rss/1646",
  },

  Syria: {
    "North Press Agency": "https://npasyria.com/en/feed/",
    "Syria Direct": "https://syriadirect.org/feed/",
    "Syrian Observer": "https://syrianobserver.com/feed",
    "Enab Baladi": "https://english.enabbaladi.net/feed/",
    Levant24: "https://levant24.com/feed/",
  },

  Tanzania: {
    "The Guardian": "https://www.theguardian.com/world/tanzania/rss",
    "Daily News (Tanzania)": "https://dailynews.co.tz/feed/",
    "The Chanzo": "https://thechanzo.com/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/tanzania/headlines.rdf",
  },

  Thailand: {
    "The Guardian": "https://www.theguardian.com/world/thailand/rss",
    "Thai Enquirer": "https://www.thaienquirer.com/feed/",
    "Khaosod English": "https://www.khaosodenglish.com/feed/",
    "Bangkok Post": "https://www.bangkokpost.com/rss/data/topstories.xml",
  },

  "The Gambia": {
    "The Alkamba Times": "https://www.alkambatimes.com/feed/",
    "Kerr Fatou": "https://www.kerrfatou.com/feed/",
    "The Standard (Gambia)": "https://standard.gm/feed/",
  },

  Tunisia: {
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/tunisia/headlines.rdf",
    Leaders: "https://www.leaders.com.tn/rss",
    "La Presse (Tunisia)": "https://lapresse.tn/feed/",
    Webdo: "https://www.webdo.tn/fr/feed/",
    Kapitalis: "https://kapitalis.com/tunisie/feed/",
  },

  Turkey: {
    "Turkish Minute": "https://www.turkishminute.com/feed/",
    "Hürriyet Daily News": "https://www.hurriyetdailynews.com/rss.aspx",
    "Daily Sabah": "https://www.dailysabah.com/rss/turkiye",
    Bianet: "https://bianet.org/english/rss",
    "Anadolu Agency": "https://www.aa.com.tr/en/rss/default?cat=turkiye",
    Medyascope: "https://medyascope.tv/feed/",
  },

  Uganda: {
    SoftPower: "https://www.softpower.ug/feed/",
    "The Independent (Uganda)": "https://www.independent.co.ug/feed/",
    "PML Daily": "https://www.pmldaily.com/feed",
    "The Observer (Uganda)": "https://observer.ug/feed",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/uganda/headlines.rdf",
  },

  Ukraine: {
    "The Guardian": "https://www.theguardian.com/world/ukraine/rss",
    "Kyiv Post": "https://www.kyivpost.com/feed",
    "Ukrainska Pravda": "https://www.pravda.com.ua/eng/rss/",
    Ukrinform: "https://www.ukrinform.net/rss/block-lastnews",
    "Euromaidan Press": "https://euromaidanpress.com/feed/",
  },

  "United Kingdom": {
    "The Guardian": "https://www.theguardian.com/uk-news/rss",
    "Daily Mirror": "https://www.mirror.co.uk/news/uk-news/?service=rss",
    "Channel 4 News": "https://www.channel4.com/news/uk/feed",
    "Sky News": "https://feeds.skynews.com/feeds/rss/uk.xml",
    BBC: "https://feeds.bbci.co.uk/news/uk/rss.xml",
    "Evening Standard": "https://www.standard.co.uk/news/uk/rss",
  },

  "United States": {
    "The Guardian": "https://www.theguardian.com/us-news/rss",
    "PBS NewsHour": "https://www.pbs.org/newshour/feeds/rss/nation",
    NPR: "https://feeds.npr.org/1003/rss.xml",
    "NBC News": "https://feeds.nbcnews.com/nbcnews/public/news",
    "LA Times": "https://www.latimes.com/nation/rss2.0.xml",
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml",
    "ABC News": "https://abcnews.go.com/abcnews/usheadlines",
    "CBS News": "https://www.cbsnews.com/latest/rss/us",
  },

  Uruguay: {
    MercoPress: "https://en.mercopress.com/rss/uruguay",
    "la diaria": "https://ladiaria.com.uy/feeds/articulos/",
    "Montevideo Portal": "https://www.montevideo.com.uy/anxml.aspx?59",
  },

  Uzbekistan: {
    "Gazeta.uz": "https://www.gazeta.uz/en/rss/",
    Daryo: "https://daryo.uz/en/rss",
    UzDaily: "https://www.uzdaily.uz/en/rss",
    "Spot.uz": "https://www.spot.uz/rss/",
  },

  Venezuela: {
    "Caracas Chronicles": "https://www.caracaschronicles.com/feed/",
    "The Guardian": "https://www.theguardian.com/world/venezuela/rss",
    "El Pitazo": "https://elpitazo.net/feed/",
    "Efecto Cocuyo": "https://efectococuyo.com/feed/",
  },

  Zambia: {
    "Zambia Monitor": "https://www.zambiamonitor.com/feed/",
    "Lusaka Times": "https://www.lusakatimes.com/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/zambia/headlines.rdf",
    Diggers: "https://diggers.news/feed/",
  },

  Zimbabwe: {
    NewZimbabwe: "https://www.newzimbabwe.com/feed/",
    "Nehanda Radio": "https://nehandaradio.com/feed/",
    "The Zimbabwe Independent": "https://www.theindependent.co.zw/feed/",
    AllAfrica: "https://allafrica.com/tools/headlines/rdf/zimbabwe/headlines.rdf",
    ZimEye: "https://www.zimeye.net/feed/",
  },
};

/** URL-safe form of a country name, for the Countries page filter. */
export function countryToSlug(country: string): string {
  return country
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The offered country a slug names, or null. */
export function slugToCountry(slug: string): string | null {
  return COUNTRIES.find((country) => countryToSlug(country) === slug) ?? null;
}
