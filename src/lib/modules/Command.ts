import { O, pipe, R } from '@that-hatter/scrapi-factory/fp';
import { Ctx, dd, Err, Op, str } from '.';

export type Execution = (
  parameters: ReadonlyArray<string>,
  message: Readonly<dd.Message>
) => Op.Op<unknown>;

export type Command = {
  readonly name: string;
  readonly syntax: string;
  readonly description: string;
  readonly aliases: ReadonlyArray<string>;
  readonly devOnly?: boolean;
  readonly execute: Execution;
};

// TODO: more valid cases? (specific admin users, debug mode, etc.)
export const devCheck =
  (message: dd.Message) =>
  ({ dev }: Ctx.Ctx): boolean => {
    if (dev.admin === message.authorId.toString()) return true;
    if (dev.guild.toString() === message.guildId?.toString()) return true;
    return !!dev.users[message.authorId.toString()];
  };

const embedFields =
  (cmd: Command) =>
  (ctx: Ctx.Ctx): Array<dd.DiscordEmbedField> => {
    const syntaxField: dd.DiscordEmbedField = {
      name: 'Syntax',
      value: str.inlineCode(ctx.prefix + cmd.syntax),
      inline: true,
    };
    if (cmd.aliases.length === 0) return [syntaxField];
    const aliasField = {
      name: 'Aliases',
      value: cmd.aliases.map(str.inlineCode).join(', '),
      inline: true,
    };
    return [syntaxField, aliasField];
  };

export const embed = (cmd: Command): R.Reader<Ctx.Ctx, dd.Embed> =>
  pipe(
    embedFields(cmd),
    R.map((fields) => ({
      title: cmd.name,
      description: cmd.description,
      fields,
    }))
  );

export const err =
  (cmd: Command, message: dd.Message) =>
  (err: Err.Err): Err.Err => {
    const reason = pipe(
      err.reason,
      O.orElse(() => O.some(message))
    );

    const devAlert = pipe(
      err.devAlert,
      O.map(str.append('\n\n-# Encountered while processing command: ')),
      O.map(str.append(cmd.name))
    );

    const userAlert = pipe(
      err.userAlert,
      O.orElse(() => {
        if (O.isNone(err.devAlert)) return O.none;
        return O.some(
          'An error was encountered while processing your command. ' +
            'This incident has been reported.'
        );
      })
    );

    return { devAlert, userAlert, reason };
  };
