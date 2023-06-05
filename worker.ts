import express from "express";
import * as dotenv from "dotenv";
dotenv.config();
import { Worker } from "bullmq";

const app = express();
const port = process.env.PORT;
const SD = process.env.SD;
const model = process.env.MODEL;

const worker = new Worker(
  model!,
  async (job) => {
    console.log("Received job")
    /// Make request to AUTOMATIC1111 local install API
    const aaa = await fetch(`${SD}sdapi/v1/txt2img`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job.data),
    });

    /// Check if call is successful
    if (aaa.status === 200) {
      /// Pass base64 if successful
      const json = await aaa.json();
      return {
        base64: json.images[0],
        seed: JSON.parse(json.info).seed,
      };
    } else {
      /// Throw error if unsuccessful
      throw new Error("Error Generating");
    }
  },
  {
    concurrency: 1,
    connection: {
      host: process.env.REDIS_URL,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASS,
    },
  }
);

worker.on("completed", () => {
  console.log("Job completed");
});

worker.on("failed", () => {
  console.log("Job failed");
});

app.listen(port, () => {
  console.log(`Running on port ${port}`);
});
