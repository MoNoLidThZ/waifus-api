import express, { Request, Response, NextFunction } from "express";
import * as dotenv from "dotenv";
dotenv.config();
import { Queue } from "bullmq";
import * as bodyParser from "body-parser";
import cors from "cors";
import mysql from "mysql2";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

/// Set up express stuff
const app = express();
const jsonParser = bodyParser.json();
const options: cors.CorsOptions = {
  origin: "*",
};
app.use(cors(options));

/// Set UTC time
dayjs.extend(utc);

/// env variables
const redisUrl = process.env.REDIS_URL;
const redisPort = Number(process.env.REDIS_PORT);
const redisPass = process.env.REDIS_PASS;
const port = process.env.API_PORT;
const delay = Number(process.env.DELAY);
const steps = Number(process.env.STEPS);
const limit = Number(process.env.LIMIT);
const mysqlUrl = process.env.MYSQL_URL;
const mysqlPort = Number(process.env.MYSQL_PORT);
const mysqlUser = process.env.MYSQL_USER;
const mysqlPass = process.env.MYSQL_PASS;
const mysqlDatabase = process.env.MYSQL_DATABASE;

/// mysql
const connection = mysql
  .createConnection({
    host: mysqlUrl,
    port: mysqlPort,
    user: mysqlUser,
    password: mysqlPass,
    database: mysqlDatabase,
    rowsAsArray: true,
  })
  .promise();

/// queues
const anythingQueue = new Queue("anything", {
  connection: {
    host: redisUrl,
    port: redisPort,
    password: redisPass,
  },
});

const aomQueue = new Queue("aom", {
  connection: {
    host: redisUrl,
    port: redisPort,
    password: redisPass,
  },
});

const counterfeitQueue = new Queue("counterfeit", {
  connection: {
    host: redisUrl,
    port: redisPort,
    password: redisPass,
  },
});

const defaults: any = {
  anything: {
    prompt: "masterpiece, best quality",
    negative_prompt:
      "EasyNegative, extra fingers,fewer fingers, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts,signature, watermark, username, blurry, artist name",
    sampler_index: "DPM++ 2M Karras",
    steps: steps,
    cfg_scale: 7,
    sd_model_checkpoint: "anything-v4.0.ckpt",
    denoising_strength: 0,
    seed: -1,
  },
  aom: {
    prompt: "",
    negative_prompt:
      "EasyNegative, (worst quality, low quality:1.4), lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts,signature, watermark, username, blurry, artist name",
    sampler_index: "DPM++ 2M Karras",
    steps: steps,
    cfg_scale: 5,
    sd_model_checkpoint: "aom3.safetensors",
    denoising_strength: 0.5,
    seed: -1,
  },
  counterfeit: {
    prompt: "((masterpiece,best quality))",
    negative_prompt:
      "EasyNegative, extra fingers,fewer fingers, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts,signature, watermark, username, blurry, artist name",
    sampler_index: "DPM++ 2M Karras",
    steps: steps,
    cfg_scale: 10,
    sd_model_checkpoint: "counterfeit-v2.5.safetensors",
    denoising_strength: 0.5,
    seed: -1,
  },
};

async function getCountPeriod(period: string) {
  const now = new Date();
  let end;
  let start;
  switch (period) {
    case "hour":
      end = now.setUTCMinutes(60, 0, 0) / 1e3;
      start = end - 3600;
      break;
    case "day":
      end = now.setUTCHours(24, 0, 0, 0) / 1e3;
      start = end - 86400;
      break;
    case "week":
      end =
        Number(
          dayjs().utc().day(7).hour(0).minute(0).second(0).millisecond(0)
        ) / 1e3;
      start = end - 604800;
      break;
    default:
      return null;
  }
  const query = await connection.query(
    `
    select sum(count)
    from counter 
    where hour > (?) AND hour <= (?)
  `,
    [start, end]
  );
  return query[0][0][0];
}

function getQueue(model: string): Queue | null {
  switch (model) {
    case "anything":
      return anythingQueue;
    case "aom":
      return aomQueue;
    case "counterfeit":
      return counterfeitQueue;
    default:
      return null;
  }
}

app.get("/", (req: Request, res: Response, next: NextFunction) => {
  return res.status(200).send("API is Active");
});

app.get(
  "/job/count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const promises = Promise.all([
        getCountPeriod("hour"),
        getCountPeriod("day"),
        getCountPeriod("week"),
      ]);

      const [hour, day, week] = await promises;
      return res.status(200).send({ hour, day, week });
    } catch (error: any) {
      return res.status(500).send(error.message);
    }
  }
);

app.get(
  "/job/queue/:model",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const model = req.params.model.toLowerCase();
      const queue = getQueue(model);
      if (!queue) {
        return res.sendStatus(400);
      } else {
        const result = await queue.getJobCounts("active", "delayed", "waiting");
        const count =
          Number(result.active) +
          Number(result.delayed) +
          Number(result.waiting);
        return res.status(200).send(count.toString());
      }
    } catch (error: any) {
      return res.status(500).send(error.message);
    }
  }
);

app.get(
  "/job/status/:model/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let queue = getQueue(req.params.model.toLowerCase());
      if (!queue) return res.sendStatus(400);
      const result = await queue.getJobState(req.params.id.toLowerCase());
      return res.status(200).send(result);
    } catch (error: any) {
      return res.status(500).send(error.message);
    }
  }
);

app.get(
  "/job/result/:model/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let queue = getQueue(req.params.model.toLowerCase());
      if (!queue) return res.sendStatus(400);
      const id = req.params.id.toLowerCase();
      const state = await queue.getJobState(id);
      if (state !== "completed") return res.sendStatus(400);
      const result = await queue.getJob(id);
      return res.status(200).send(result.returnvalue);
    } catch (error: any) {
      return res.status(500).send(error.message);
    }
  }
);

app.post(
  "/job/submit/:model",
  jsonParser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const model = req.params.model.toLowerCase();
      const queue = await getQueue(model);
      if (!queue) return res.sendStatus(400);
      const result = await queue.getJobCounts("active", "delayed", "waiting");
      const count =
        Number(result.active) + Number(result.delayed) + Number(result.waiting);
      if (count > limit) {
        return res.sendStatus(503);
      }
      const payload = { ...defaults[model] };

      const positive = req.body.prompt;
      const negative_prompt = req.body.negative_prompt;
      const cfg_scale = req.body.cfg_scale;
      const denoising_strength = req.body.denoising_strength;
      const seed = req.body.seed;
      if (positive) {
        payload.prompt += `, ${positive.toString()}`;
      }
      if (negative_prompt) {
        payload.negative_prompt += `, ${negative_prompt.toString()}`;
      }
      if (cfg_scale) {
        payload.cfg_scale = cfg_scale;
      }
      if (denoising_strength) {
        payload.denoising_strength = denoising_strength;
      }
      if (seed) {
        payload.seed = seed;
      }
      const job = await queue.add(model, payload, {
        delay: delay,
        removeOnComplete: {
          age: 600,
          count: 500,
        },
        removeOnFail: {
          age: 600,
          count: 500,
        },
      });

      try {
        const currentHour = new Date().setUTCMinutes(60, 0, 0) / 1e3;
        await connection.query(
          `
          INSERT INTO counter (hour, count)
          VALUES (?,?)
          ON DUPLICATE KEY UPDATE
          COUNT = COUNT + 1
          `,
          [currentHour, 1]
        );

        return res.status(201).send(job.id);
      } catch (error) {
        return res.status(201).send(job.id);
      }
    } catch (error: any) {
      return res.status(500).send(error.message);
    }
  }
);

app.listen(port, () => {
  console.log(`API running on ${port}`);
});
