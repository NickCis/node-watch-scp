import path from 'path';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import watch from 'node-watch';
import askpassword from 'askpassword';
import { NodeSSH } from 'node-ssh';
import debounce from 'lodash/debounce.js';
import ignore from 'ignore';

async function parseConfig(to, argv = {}) {
  const [ssh, folder] = to.split(':');
  const [user, host] = ssh.split('@');
  const config = {
    ssh: {
      tryKeyboard: true,
      username: user || 'root',
      host,
    },
    folder,
    cwd: folder || argv.cwd,
  };

  for (const key of argv.key) {
    try {
      await fs.access(key, constants.R_OK);
      config.ssh.privateKey = key;
      break;
    } catch (e) {}
  }

  if (argv.password) {
    config.ssh.password = argv.password;
    if (argv.password === '-') {
      process.stdout.write('Please enter a password: ');
      config.ssh.password = (await askpassword(process.stdin)).toString();
    }
  }

  return config;
}

async function getIgnore(ignoreFile) {
  try {
    await fs.access(ignoreFile, constants.R_OK);
    return ignore().add((await fs.readFile(ignoreFile)).toString());
  } catch (e) {}
}

async function main(from, to, argv) {
  console.log(`[Watching] ${from.join(', ')} -> ${to}`);

  const config = await parseConfig(to, argv);
  const ssh = new NodeSSH();
  await ssh.connect(config.ssh);

  let pid;
  const run = debounce(async () => {
    if (!argv.cmd) return;
    if (pid) {
      await ssh.execCommand(`pkill -g ${pid}`);
      pid = undefined;
    }

    console.log('[remote]', argv.cmd);
    ssh.connection.exec(
      `echo "EXEC PID: $$"; ${argv.cmd}`,
      { cwd: config.cwd },
      (err, stream) => {
        if (err) {
          console.error(err);
          return;
        }

        stream
          .on('data', buffer => {
            const lines = buffer.toString();

            for (const line of lines.split('\n')) {
              if (line.startsWith('EXEC PID: ')) {
                pid = line.substr('EXEC PID: '.length);
                continue;
              }

              if (line) console.log('[remote]', line);
            }
          })
          .on('end', () => {
            pid = undefined;
          });
      },
    );
  }, argv.wait);

  const options = {
    recursive: true,
  };

  const ignore = await getIgnore(argv.ignore);
  if (ignore) {
    options.filter = (f, skip) => {
      const result = ignore.test(f);
      if (result.ignored) return skip;
      return true;
    };
  }

  watch(from, options, async (evt, name) => {
    const file = path.resolve(name);
    const remoteFile = path.join(config.folder, name);
    console.log('[%s] %s -> %s ', evt, file, remoteFile);

    switch (evt) {
      case 'update':
        await ssh.putFile(file, remoteFile);
        run();
        break;

      default:
        break;
    }
  });
}

export default main;
