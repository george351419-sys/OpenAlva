import { CliUsageError, dispatch } from './dispatch.js';

dispatch(process.argv.slice(2))
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(JSON.stringify({ error: String(err?.message ?? err) }));
    process.exit(1);
  });
