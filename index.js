require("dotenv").config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const MATCH_TIMEOUT_MS = 5 * 60 * 1000;

// Temporary in-memory match storage. This resets when the bot restarts.
const matches = new Map();
let nextMatchNumber = 1;

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

function createMatchId() {
  const matchId = `match-${Date.now()}-${nextMatchNumber}`;
  nextMatchNumber += 1;
  return matchId;
}

function createCancelButton(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_match:${matchId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
}

function privateInteractionReply(content, interaction) {
  const reply = { content };

  if (interaction.guild) {
    reply.ephemeral = true;
  }

  return reply;
}

function findActiveMatchStartedBy(userId) {
  for (const match of matches.values()) {
    if (match.playerOneId === userId) {
      return match;
    }
  }

  return null;
}

function findActiveMatchForPlayer(userId) {
  for (const match of matches.values()) {
    if (match.players[userId]) {
      return match;
    }
  }

  return null;
}

function findMatchWaitingForOpponent(userId, channelId) {
  for (const match of matches.values()) {
    if (
      match.status === "waiting_for_opponent" &&
      match.playerOneId === userId &&
      match.channelId === channelId
    ) {
      return match;
    }
  }

  return null;
}

function findMatchWaitingForUnits(userId) {
  for (const match of matches.values()) {
    if (
      match.status === "waiting_for_units" &&
      match.players[userId] &&
      !match.players[userId].units
    ) {
      return match;
    }
  }

  return null;
}

function parseTwoUnits(content) {
  const units = content
    .split(",")
    .map((unit) => unit.trim())
    .filter(Boolean);

  return units.length === 2 ? units : null;
}

function clearMatchTimer(match) {
  if (match.timer) {
    clearTimeout(match.timer);
    match.timer = null;
  }
}

function startMatchTimer(match, reason) {
  clearMatchTimer(match);

  match.timer = setTimeout(async () => {
    await cancelMatch(match.id, reason);
  }, MATCH_TIMEOUT_MS);
}

async function cancelMatch(matchId, reason) {
  const match = matches.get(matchId);
  if (!match) return;

  clearMatchTimer(match);
  matches.delete(matchId);

  try {
    const channel = await client.channels.fetch(match.channelId);
    await channel.send(`Match setup ${match.id} was canceled. ${reason}`);
  } catch (error) {
    console.error("Could not send cancel message:", error);
  }
}

async function askPlayersForUnits(match) {
  const playerOne = await client.users.fetch(match.playerOneId);
  const playerTwo = await client.users.fetch(match.playerTwoId);
  const prompt =
    `Match setup ${match.id}\n` +
    "What two units will you be using? Please reply like: unit1, unit2";

  await playerOne.send({ content: prompt, components: [createCancelButton(match.id)] });
  await playerTwo.send({ content: prompt, components: [createCancelButton(match.id)] });
}

async function sendMatchConfirmation(match) {
  const channel = await client.channels.fetch(match.channelId);
  const playerOneUnits = match.players[match.playerOneId].units.join(", ");
  const playerTwoUnits = match.players[match.playerTwoId].units.join(", ");

  await channel.send(
    `Match Confirmed (${match.id})\n` +
      `Player 1: <@${match.playerOneId}> - Units: ${playerOneUnits}\n` +
      `Player 2: <@${match.playerTwoId}> - Units: ${playerTwoUnits}`
  );
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("cancel_match:")) return;

  const matchId = interaction.customId.split(":")[1];
  const match = matches.get(matchId);

  if (!match) {
    await interaction.reply(
      privateInteractionReply("That match setup is no longer active.", interaction)
    );
    return;
  }

  const canCancel =
    interaction.user.id === match.playerOneId || interaction.user.id === match.playerTwoId;

  if (!canCancel) {
    await interaction.reply(
      privateInteractionReply("Only the players in this match setup can cancel it.", interaction)
    );
    return;
  }

  await interaction.reply(
    privateInteractionReply(`Match setup ${match.id} was canceled.`, interaction)
  );

  await cancelMatch(match.id, "Canceled by a player.");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!ping") {
    await message.reply("pong");
    return;
  }

  if (message.channel.isDMBased()) {
    const match = findMatchWaitingForUnits(message.author.id);
    if (!match) return;

    const units = parseTwoUnits(message.content);
    if (!units) {
      await message.reply({
        content: "Please send exactly two units separated by a comma, like: unit1, unit2",
        components: [createCancelButton(match.id)],
      });
      return;
    }

    match.players[message.author.id].units = units;
    await message.reply("Got it. Waiting for the other player if they have not answered yet.");

    const bothPlayersAnswered = Object.values(match.players).every((player) => player.units);
    if (!bothPlayersAnswered) return;

    clearMatchTimer(match);

    try {
      await sendMatchConfirmation(match);
    } catch (error) {
      console.error("Could not send match confirmation:", error);
    } finally {
      matches.delete(match.id);
    }

    return;
  }

  if (!message.guild) return;

  const waitingMatch = findMatchWaitingForOpponent(message.author.id, message.channel.id);
  if (waitingMatch) {
    const mentionedUsers = [...message.mentions.users.values()].filter(
      (user) => user.id !== client.user.id
    );
    const opponent = mentionedUsers[0];

    if (!opponent) {
      await message.reply({
        content: "Please mention one human opponent.",
        components: [createCancelButton(waitingMatch.id)],
      });
      return;
    }

    if (opponent.id === message.author.id) {
      await message.reply({
        content: "You cannot play against yourself. Please mention another human opponent.",
        components: [createCancelButton(waitingMatch.id)],
      });
      return;
    }

    if (opponent.bot) {
      await message.reply({
        content: "Please mention a human opponent, not a bot.",
        components: [createCancelButton(waitingMatch.id)],
      });
      return;
    }

    if (findActiveMatchForPlayer(opponent.id)) {
      await message.reply({
        content: "That player already has an active match setup.",
        components: [createCancelButton(waitingMatch.id)],
      });
      return;
    }

    waitingMatch.playerTwoId = opponent.id;
    waitingMatch.status = "waiting_for_units";
    waitingMatch.players[opponent.id] = { units: null };

    try {
      await askPlayersForUnits(waitingMatch);
      startMatchTimer(
        waitingMatch,
        "Both players did not submit their units within 5 minutes."
      );
      await message.reply("I sent both players a DM. Please answer there with your two units.");
    } catch (error) {
      console.error("Could not DM one or both players:", error);
      await cancelMatch(
        waitingMatch.id,
        "I could not DM one or both players. Please make sure both players allow DMs from this server, then try again."
      );
    }

    return;
  }

  const mentionedBot =
    message.mentions.users.has(client.user.id) || message.mentions.members?.has(client.user.id);

  if (!mentionedBot) return;

  if (findActiveMatchStartedBy(message.author.id)) {
    await message.reply("You already have an active match setup.");
    return;
  }

  if (findActiveMatchForPlayer(message.author.id)) {
    await message.reply("You are already part of an active match setup.");
    return;
  }

  const match = {
    id: createMatchId(),
    channelId: message.channel.id,
    playerOneId: message.author.id,
    playerTwoId: null,
    status: "waiting_for_opponent",
    timer: null,
    players: {
      [message.author.id]: { units: null },
    },
  };

  matches.set(match.id, match);
  startMatchTimer(match, "No opponent was selected within 5 minutes.");

  await message.reply({
    content: `Match setup ${match.id} started. Who is your opponent? Please mention them.`,
    components: [createCancelButton(match.id)],
  });
});

client.login(process.env.TOKEN);
