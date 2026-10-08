import type { Topic } from "@/types";
import type { COUNTRIES_TOPIC } from "@/config/countries";

/**
 * One hand-written line per pickable topic, shown under its name in the topic
 * grid. Each line says what the topic's feeds (docs/(C) SOURCE_CATALOG.md)
 * actually cover, and is worded to tell near-duplicates apart: Morocco,
 * Morocco Politics and Morocco Finance; Economy, World Finance and US
 * Finance; Health & Medicine and Health & Wellness. A line must not promise
 * coverage the feeds don't have.
 */
export const TOPIC_DESCRIPTIONS: Record<Exclude<Topic, typeof COUNTRIES_TOPIC>, string> = {
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
  Morocco: "Morocco's general news: society, regions, the diaspora and the day's events",
  "UK Politics": "Westminster: the government, parliament and the parties",
  "European Union": "The EU's institutions and policy, and news across Europe",
  "Middle East": "News across the Middle East and the Gulf",
  Africa: "News across the continent, from Nigeria and Kenya to South Africa",
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

  Football: "Soccer: Europe's top leagues, transfers and Moroccan football",
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
