import type { Topic } from "@/types";
import type { COUNTRIES_TOPIC } from "@/config/countries";

/**
 * One hand-written line per pickable topic, shown under its name in the topic
 * grid. Each line says what the topic's feeds (docs/(C) SOURCE_CATALOG.md)
 * actually cover, and is worded to tell near-duplicates apart: Morocco
 * Politics and Morocco Finance; Economy, World Finance and US Finance; Health &
 * Medicine and Health & Wellness. A line must not promise coverage the feeds
 * don't have.
 *
 * Each line fits on one line of its chip: about 190 px of 12 px text on a
 * laptop-width screen, which is roughly 33 characters.
 * src/config/__tests__/topicGroups.test.ts holds the character cap. The topic
 * search matches these words and TOPIC_SEARCH_TERMS below, so a word cut to
 * make a line fit stays findable.
 */
export const TOPIC_DESCRIPTIONS: Record<Exclude<Topic, typeof COUNTRIES_TOPIC>, string> = {
  "Tech/AI": "AI, software, big tech, startups",
  Cybersecurity: "Hacks, breaches, ransomware",
  "Consumer Tech & Gadgets": "Phones, laptops, gadget reviews",
  Gaming: "Games, consoles, the industry",
  Space: "Launches, missions, astronomy",
  Science: "Research, physics to biology",
  "Climate & Environment": "Climate, pollution and nature",
  "Energy Transition & Renewables": "Solar, wind, batteries and EVs",
  "Health & Medicine": "Medical research, public health",
  "Biotech & Pharma": "Drug makers, trials, approvals",

  "US Politics": "White House, Congress, parties",
  "Morocco Politics": "Morocco's government, parties",
  "French Politics": "Élysée, government, parties",
  Geopolitics: "Wars, diplomacy, world news",
  "UK Politics": "Westminster and the parties",
  "European Union": "EU policy, news across Europe",
  "Middle East": "The Middle East and the Gulf",
  Africa: "Nigeria, South Africa and more",
  "Asia-Pacific": "China, Japan, India, SE Asia",
  "Latin America": "From Mexico to Argentina",
  Elections: "Votes worldwide, US in depth",
  Immigration: "Migration, borders and asylum",
  "Defense & Security": "Militaries, weapons and wars",
  "Human Rights": "Rights abuses, civil liberties",

  "Morocco Finance": "Bank Al-Maghrib, bourse, firms",
  "US Finance": "Wall Street, the Fed, US firms",
  "World Finance": "Global business, City to Asia",
  Economy: "Growth, inflation, jobs, trade",
  "Markets & Investing": "Stocks, bonds and currencies",
  "Personal Finance": "Saving, tax, pensions, loans",
  "Real Estate": "Housing markets and property",
  "Energy & Oil": "Oil, gas, OPEC, energy prices",
  Crypto: "Bitcoin, tokens and regulation",
  Banking: "Banks, lenders and regulation",
  "Retail & Consumer": "Shops, brands and shoppers",
  Automotive: "Carmakers, new models, EVs",

  Football: "Soccer: top leagues, transfers",
  Basketball: "NBA games, trades, injuries",
  Tennis: "ATP, WTA and the Grand Slams",
  "American Football": "NFL games, trades, injuries",
  "Formula 1": "Races, teams and drivers",
  Cricket: "Tests, ODIs, T20, India in depth",
  Rugby: "Union: internationals and clubs",
  Golf: "The pro tours and the majors",
  "Boxing & MMA": "Boxing, the UFC and MMA",
  Cycling: "Tour de France, the pro peloton",
  Baseball: "MLB games, trades, injuries",
  "Olympics & Athletics": "Track and field, the Olympics",

  "Film & TV": "Films, series and streaming",
  Music: "Releases, artists and tours",
  Books: "New books, authors, publishing",
  "Art & Design": "Exhibitions, art market, design",
  Architecture: "Buildings, architects, projects",
  "Food & Drink": "Restaurants, recipes and chefs",
  Travel: "Destinations, airlines, hotels",
  Fashion: "Designers, fashion weeks",
  "Celebrity & Entertainment": "Stars, awards and showbiz",
  Education: "Schools, universities, policy",
  Religion: "Faith and religion in public life",
  "Health & Wellness": "Fitness, nutrition and sleep",

  "Law & Courts": "Courts, rulings and trials",
  Crime: "Crime, policing and justice",
  "Weather & Natural Disasters": "Storms, floods, fires, quakes",
  "Media & Journalism": "News outlets and journalists",
};

/**
 * Longer wording per topic that the topic search matches but the grid never
 * shows: the words a reader might type ("Washington", "parliament",
 * "Hollywood", "mortgage") that don't fit on a one-line chip. Held to the
 * same rule as the display line: no promise the topic's feeds don't keep.
 */
export const TOPIC_SEARCH_TERMS: Record<Exclude<Topic, typeof COUNTRIES_TOPIC>, string> = {
  "Tech/AI": "AI, software and the tech industry: big tech, startups, research",
  Cybersecurity: "Hacks, data breaches, ransomware and security flaws",
  "Consumer Tech & Gadgets": "Phones, laptops, PC hardware and new devices, with reviews",
  Gaming: "Video games, consoles and the games industry",
  Space: "Launches, missions, astronomy and the space industry",
  Science: "New research across the sciences, from physics to biology",
  "Climate & Environment": "Climate change, climate policy, pollution and nature",
  "Energy Transition & Renewables": "Solar, wind, batteries and electric vehicles",
  "Health & Medicine": "Medical research, public health, hospitals and health policy",
  "Biotech & Pharma": "Drug makers, clinical trials, approvals and biotech deals",

  "US Politics": "Washington: the White House, Congress, the parties and campaigns",
  "Morocco Politics": "Morocco's government, parliament, parties and policy",
  "French Politics": "The Élysée, the government, parliament and parties in France",
  Geopolitics: "The day's world news: wars, diplomacy and relations between powers",
  "UK Politics": "Westminster: the government, parliament and the parties",
  "European Union": "The EU's institutions and policy, and news across Europe",
  "Middle East": "News across the Middle East and the Gulf",
  Africa: "News across the continent, from Nigeria to South Africa",
  "Asia-Pacific": "China, Japan, India, Southeast Asia and the Pacific",
  "Latin America": "News from Latin America, from Mexico to Argentina",
  Elections: "Votes and campaigns worldwide, with US races in depth",
  Immigration: "Migration, borders, asylum and immigration policy",
  "Defense & Security": "Militaries, weapons, defence budgets and the wars they fight",
  "Human Rights": "Rights abuses, civil liberties and the groups that track them",

  "Morocco Finance": "Bank Al-Maghrib, the Casablanca bourse, Moroccan companies",
  "US Finance": "Wall Street, the Fed and American companies",
  "World Finance": "International business and finance, from the City to Asia",
  Economy: "Growth, inflation, jobs, interest rates and trade",
  "Markets & Investing": "Stocks, bonds, currencies and what moves them",
  "Personal Finance": "Saving, tax, pensions, mortgages and everyday money",
  "Real Estate": "Housing markets, mortgages and property",
  "Energy & Oil": "Oil, gas, OPEC, energy prices and energy companies",
  Crypto: "Bitcoin, crypto markets, tokens and regulation",
  Banking: "Banks, lenders and banking regulation",
  "Retail & Consumer": "Shops, brands, shopping habits and consumer companies",
  Automotive: "Carmakers, new models, EVs and the car industry",

  Football: "Soccer: Europe's top leagues and transfers",
  Basketball: "The NBA: games, trades and injury news",
  Tennis: "The ATP and WTA tours and the Grand Slams",
  "American Football": "The NFL: games, trades and injury news",
  "Formula 1": "Grand prix racing: races, teams and drivers",
  Cricket: "Test, one-day and T20 cricket, with India in depth",
  Rugby: "Rugby union: internationals and club rugby",
  Golf: "The pro tours and the majors",
  "Boxing & MMA": "Boxing, the UFC and mixed martial arts",
  Cycling: "Road racing: the Tour de France and the pro peloton",
  Baseball: "MLB: games, trades and injury news",
  "Olympics & Athletics": "Track and field and the Olympic movement",

  "Film & TV": "Films, series, streaming and the Hollywood business",
  Music: "New releases, artists, tours and the music business",
  Books: "New books, authors, reviews and publishing",
  "Art & Design": "Exhibitions, the art market and product design",
  Architecture: "Buildings, architects and new projects",
  "Food & Drink": "Restaurants, recipes, chefs and food culture",
  Travel: "Destinations, airlines, hotels and the travel industry",
  Fashion: "Designers, fashion weeks, brands and style",
  "Celebrity & Entertainment": "Stars, awards, showbiz and arts news",
  Education: "Schools, universities and education policy",
  Religion: "Faith, religious communities and religion in public life",
  "Health & Wellness": "Fitness, nutrition, sleep and everyday health",

  "Law & Courts": "Courts, rulings, trials and the law",
  Crime: "Crime, policing and criminal justice",
  "Weather & Natural Disasters": "Storms, floods, wildfires, earthquakes and extreme weather",
  "Media & Journalism": "News outlets, journalists and the media business",
};
