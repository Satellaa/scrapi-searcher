import { E, O, pipe, RA, RNEA, RR, TE } from '@that-hatter/scrapi-factory/fp';
import { collection as commands } from './lib/commands';
import { list as events } from './lib/events';
import { collection as componentInteractions } from './lib/interactions';
import { Data, dd, Decoder, Err, Event, Github, Op, str } from './lib/modules';
import { utils } from './lib/utils';
import { BitNames } from './ygo';

const envDecoder = pipe(
  Decoder.struct({
    DEV_ADMIN: Decoder.string,
    DEV_GUILD: Decoder.string,
    DEV_USERS: Decoder.string,
    DEV_LOGS_CHANNEL: Decoder.string,

    BOT_PREFIX: Decoder.string,
    BOT_TOKEN: Decoder.string,

    GITHUB_ACCESS_TOKEN: Decoder.string,
    GITHUB_WEBHOOK_PORT: Decoder.numString,
    GITHUB_WEBHOOK_SECRET: Decoder.string,
  }),
  Decoder.intersect(
    Decoder.partial({
      PICS_DEFAULT_SOURCE: Decoder.string,
      PICS_UPLOAD_CHANNEL: Decoder.bigintString,
    })
  )
);

const program = pipe(
  TE.Do,
  TE.bind('env', () =>
    pipe(process.env, Decoder.parse(envDecoder), TE.fromEither)
  ),
  TE.bind('github', ({ env }) =>
    Github.init(
      env.GITHUB_ACCESS_TOKEN,
      env.GITHUB_WEBHOOK_PORT,
      env.GITHUB_WEBHOOK_SECRET
    )
  ),
  TE.bind('data', () => Data.init),
  TE.bind('dd', () => utils.taskify(() => import('@discordeno/bot'))),
  TE.let('bot', ({ dd, env }) =>
    dd.createBot({
      intents:
        dd.GatewayIntents.Guilds |
        dd.GatewayIntents.GuildMessages |
        dd.GatewayIntents.MessageContent |
        dd.GatewayIntents.DirectMessages,
      token: env.BOT_TOKEN,
      // TODO: pick actual desired properties once typing is safer
      // for now, this sets all properties to be true
      desiredProperties: dd.createDesiredPropertiesObject(
        {
          // exception to the above, since it causes discordeno to throw an error
          // https://github.com/discordeno/discordeno/pull/3961
          messageSnapshot: { message: false },
        },
        true
      ),
    })
  ),
  TE.bind('emojis', ({ bot }) => Op.getAppEmojis(bot)),
  TE.flatMap(({ bot, emojis, env, github, data }) => {
    const ctx = {
      bot,
      prefix: env.BOT_PREFIX,
      dev: {
        admin: env.DEV_ADMIN,
        guild: env.DEV_GUILD,
        users: pipe(
          env.DEV_USERS,
          str.split(', '),
          RNEA.map(str.split(':')),
          RNEA.map(([name, id]) => [String(id), name] as const),
          RR.fromEntries
        ),
        logs: env.DEV_LOGS_CHANNEL,
      },
      commands,
      componentInteractions,
      bitNames: BitNames.load(data.yard.api.constants.array, data.systrings),
      github: github.rest,
      picsSource: O.fromNullable(env.PICS_DEFAULT_SOURCE),
      picsChannel: O.fromNullable(env.PICS_UPLOAD_CHANNEL),
      emojis: pipe(
        emojis,
        RA.filterMap(({ id, name }) => {
          if (!id || !name) return O.none;
          return O.some([name, `<:${name}:${id}>`] as const);
        }),
        RR.fromEntries
      ),
      ...data,
    };

    const runHandler = async (handler: Op.Op<unknown>) => {
      const res = await handler(ctx)();
      if (E.isLeft(res)) return Err.sendAlerts(res.left)(ctx)();

      if (!Data.isUpdate(res.right)) return;
      const update = res.right;
      ctx.babel = update.babel ?? ctx.babel;
      ctx.yard = update.yard ?? ctx.yard;
      ctx.systrings = update.systrings ?? ctx.systrings;
      ctx.banlists = update.banlists ?? ctx.banlists;
      ctx.betaIds = update.betaIds ?? ctx.betaIds;
      ctx.konamiIds = update.konamiIds ?? ctx.konamiIds;
      ctx.shortcuts = update.shortcuts ?? ctx.shortcuts;
      ctx.pics = update.pics ?? ctx.pics;

      if (!update.yard && !update.systrings) return;
      ctx.bitNames = BitNames.load(ctx.yard.api.constants.array, ctx.systrings);
    };

    const toDiscordHandler = <K extends keyof dd.EventHandlers>(
      event: Event.Event<K>
    ): Partial<dd.EventHandlers> => ({
      [event.name]: (...params: Parameters<dd.EventHandlers[K]>) =>
        runHandler(event.handle(...params)),
    });

    bot.events = events.reduce(
      (acc, ev) => ({ ...acc, ...toDiscordHandler(ev) }),
      bot.events
    );

    github.webhook.on('push', ({ payload }) => {
      const { ref, commits } = payload;
      if (ref !== 'refs/heads/master' && ref !== 'refs/heads/main') return;
      if (commits.length === 1 && commits[0]?.message.startsWith('[auto] '))
        return;

      pipe(
        commits,
        RA.flatMap((c) => [...c.added, ...c.modified, ...c.removed]),
        (files) =>
          Data.autoUpdate(payload.compare, payload.repository.name, files),
        runHandler
      );
    });

    process.on('SIGINT', () => {
      github.webhookServer.close();
      process.exit(1);
    });

    return utils.taskify(() => {
      console.log('Starting bot...');
      return bot.start();
    });
  }),
  TE.mapError(utils.tapLog)
);

void program();
