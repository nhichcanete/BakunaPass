import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `bakunapass-test-${randomUUID()}.env`);
delete process.env.API_USERS;
delete process.env.JWT_SECRET;
