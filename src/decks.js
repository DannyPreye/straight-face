'use strict';

// Original prompts written for Straight Face. Each one tries to crack you.

const GENERAL = [
  ['🦆', 'A duck is now your landlord. He wants the rent in bread.'],
  ['🧦', 'Somewhere, the sock you lost in 2014 is living its best life.'],
  ['🐌', 'A snail just overtook your internet connection.'],
  ['🥔', 'Your potato has been sending you motivational quotes. You never replied.'],
  ['🎻', 'A tiny violin now plays every time you open the fridge.'],
  ['🐧', 'Penguins own one outfit and still look more put together than you.'],
  ['🦒', 'A giraffe with a sore throat. Really picture it.'],
  ['🪑', 'This chair has seen things. It will not elaborate.'],
  ['🐟', 'A fish trying to explain water to another fish.'],
  ['🤖', 'Your phone’s autocorrect has been planning this for years.'],
  ['🧀', 'Cheese is just milk that got its life together.'],
  ['🐈', 'Your cat is judging you. Your cat is right.'],
  ['🎬', 'In a world… where the Wi‑Fi… is down… one family… must talk to each other.'],
  ['🦷', 'Dentists ask you questions with both hands in your mouth. Every time.'],
  ['🍌', 'A banana in sunglasses is now your financial advisor.'],
  ['🐝', 'Bees are tiny and furious, and still better at teamwork than your group chat.'],
  ['🥚', 'An egg is a chicken’s “coming soon” trailer.'],
  ['🛒', 'That one shopping trolley wheel has a mind of its own, and it chose chaos.'],
  ['🦩', 'Flamingos stand on one leg because two would be showing off.'],
  ['😐', 'Don’t smile. Don’t smile. You’re thinking about smiling now, aren’t you?'],
  ['🛹', 'Your grandmother just landed a kickflip. She didn’t even look.'],
  ['🐸', 'A frog in a tiny business suit is reviewing your CV.'],
  ['📞', 'The phone rings. It’s your own voice asking if you’ve eaten.'],
  ['🦔', 'A hedgehog tried to hug a balloon. Nobody is okay.'],
];

const NAIJA = [
  ['💡', 'NEPA took light the moment you said “let me just quickly…”'],
  ['🚐', 'The danfo conductor gave you your change. All of it. On time.'],
  ['🍚', 'Mum: “We have jollof at home.” The jollof at home: white rice and stew.'],
  ['🩴', 'Your mum’s slipper has a 100% hit rate from across the room.'],
  ['📱', '“I’m on my way,” said by someone who hasn’t bathed yet.'],
  ['👵', 'Aunty at the owambe: “When are we eating your rice?” You are twelve.'],
  ['🚗', 'Third Mainland Bridge traffic. You’ve aged. Your car has aged.'],
  ['🐐', 'A goat just joined the bank queue ahead of you. Nobody is stopping it.'],
  ['📶', 'Your data finished at 99% downloaded.'],
  ['🍗', 'Party jollof in a cooler, and the spoon is fighting for its life.'],
  ['🙏', 'Pastor: “Turn to your neighbour and say…” Your neighbour is asleep.'],
  ['💸', 'Spraying money at the party, one ₦50 note at a time, very slowly.'],
  ['🛍️', '“Customer! Come and buy!” They’ve chosen you. There is no escape.'],
  ['🐔', 'The Christmas chicken in the compound has been acting suspicious since December 1st.'],
  ['🚦', 'Lagos traffic lights: more of a suggestion, really.'],
  ['⏱️', '“Sharp sharp.” It took two hours.'],
  ['🥤', 'Your uncle opened a bottle with his teeth. Again. At sixty.'],
  ['⚡', 'The gen is on. The gen is off. The gen is thinking about it.'],
  ['👗', 'The aso-ebi was “champagne gold.” It arrived Fanta orange.'],
  ['🍞', 'Agege bread so soft you could use it as a pillow.'],
  ['🎶', 'The DJ plays the same song for the seventh time. Everyone still screams.'],
  ['☎️', 'Two missed calls from Mum. She’s now calling your friends.'],
  ['🛵', 'Okada with a sofa, a goat and two passengers. Sharp bend ahead.'],
  ['🥘', 'Somebody brought jollof to a party where someone else brought jollof. Silence.'],
];

// Lines that tease you during a staring contest.
const STARE_TAUNTS = [
  ['👀', 'Your eyes are getting so dry.'],
  ['🏜️', 'Think about sand. Lots of sand.'],
  ['💨', 'Imagine a tiny breeze. Right on your eyeballs.'],
  ['🧅', 'Someone is chopping onions nearby.'],
  ['🌬️', 'A fan just turned to face you.'],
  ['🥱', 'Yawning is contagious. Just saying.'],
  ['🔦', 'Bright light. Very bright. Don’t squint.'],
  ['🪶', 'A feather is floating towards your face.'],
  ['😑', 'Blinking is free. It costs nothing. Go on.'],
  ['🫧', 'Bubbles. Popping. Right in front of you.'],
];

const PACKS = {
  general: { label: 'Everyday absurd', prompts: GENERAL },
  naija: { label: 'Naija', prompts: NAIJA },
};

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Endless shuffled stream from the chosen packs, without quick repeats.
function makeDeck(packKeys) {
  const pool = packKeys.flatMap((k) => PACKS[k]?.prompts ?? []);
  let queue = shuffled(pool);
  return () => {
    if (queue.length === 0) queue = shuffled(pool);
    return queue.pop();
  };
}

function makeTauntDeck() {
  let queue = shuffled(STARE_TAUNTS);
  return () => {
    if (queue.length === 0) queue = shuffled(STARE_TAUNTS);
    return queue.pop();
  };
}

module.exports = { PACKS, makeDeck, makeTauntDeck };
