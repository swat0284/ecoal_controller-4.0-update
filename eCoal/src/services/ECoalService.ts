import merge from "deepmerge";
import { parseStringPromise } from "xml2js";
import type {
  Config,
  CustomMapping,
  ECoalInfoResponse,
  ECoalResponse,
} from "../types";
import { batcher } from "../utils/batcher";
import { legacyFetch } from "../utils/legacyFetch";
import { logger } from "../utils/logger";

export class ECoalService {
  private config: Config;
  private mappings: CustomMapping[];

  constructor(config: Config, mappings: CustomMapping[]) {
    this.config = config;
    this.mappings = mappings;

    legacyFetch(`http://${this.config.ecoal_host}/info.cgi`, {
      user: this.config.ecoal_username,
      pass: this.config.ecoal_password,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const rawBody = await response.text();
        this.logRawResponse("info.cgi", response.headersRaw, rawBody);

        const hwData = await this.parseRawPayload<ECoalInfoResponse>(
          rawBody,
          "info.cgi",
        );

        logger.info(
          `Connected to eCoal v${hwData.cmd.hardware.hardwareversion} (${hwData.cmd.hardware.softwareversion})`,
        );
      })
      .catch((error) => {
        logger.error("Failed to fetch info.cgi data:", error);
      });
  }

  private logRawResponse(
    source: string,
    headersRaw: string,
    rawBody: string,
  ): void {
    if (!this.config.raw_data_logging) {
      return;
    }

    logger.info(`[RAW][${source}][HEADERS]\n${headersRaw}`);
    logger.info(`[RAW][${source}][BODY]\n${rawBody}`);
  }

  private async parseRawPayload<T>(rawBody: string, source: string): Promise<T> {
    try {
      return (await parseStringPromise(rawBody, {
        explicitArray: false,
        mergeAttrs: true,
        trim: true,
        normalizeTags: false,
      })) as T;
    } catch (xmlError) {
      try {
        return JSON.parse(rawBody) as T;
      } catch (jsonError) {
        const xmlMessage =
          xmlError instanceof Error ? xmlError.message : String(xmlError);
        const jsonMessage =
          jsonError instanceof Error ? jsonError.message : String(jsonError);

        throw new Error(
          `Failed to parse raw payload from ${source}. XML parse error: ${xmlMessage}. JSON parse error: ${jsonMessage}`,
        );
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetriableNetworkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);

    return (
      message.includes("ECONNRESET") ||
      message.includes("ETIMEDOUT") ||
      message.includes("EPIPE") ||
      message.includes("socket hang up")
    );
  }

  private async fetchAndParseWithRetries<T>(
    url: string,
    source: string,
    maxRetries: number = 2,
  ): Promise<T> {
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const response = await legacyFetch(url, {
          user: this.config.ecoal_username,
          pass: this.config.ecoal_password,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const rawBody = await response.text();
        this.logRawResponse(source, response.headersRaw, rawBody);
        return await this.parseRawPayload<T>(rawBody, source);
      } catch (error) {
        const retriable = this.isRetriableNetworkError(error);
        const isLastAttempt = attempt >= maxRetries;

        if (!retriable || isLastAttempt) {
          throw error;
        }

        const backoffMs = 250 * (attempt + 1);
        logger.warn(
          `Request retry ${attempt + 1}/${maxRetries} for '${url}' after network error: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.sleep(backoffMs);
      }

      attempt += 1;
    }

    throw new Error(`Unexpected retry flow termination for '${url}'`);
  }

  async fetchCustomEntries(): Promise<
    { id: string; value: number | null }[] | undefined
  > {
    logger.debug("Fetching custom entries");

    const joinedQuery = this.mappings.map((entry) => entry.id);

    if (!joinedQuery.length) {
      logger.debug("No custom temp and vtemp mappings configured, skipping");
      return;
    }

    const batches = batcher(joinedQuery, 3);

    const entries: { id: string; value: number | null }[] = [];
    let failedBatches = 0;

    for await (const batch of batches) {
      const url = `http://${this.config.ecoal_host}/getregister.cgi?device=0&${batch.join("&")}`;

      try {
        const data = await this.fetchAndParseWithRetries<ECoalResponse>(
          url,
          "getregister.cgi/custom",
        );

        batch.forEach((id) => {
          const entry = data.cmd.device.reg.find(
            (reg) => `${reg.vid}@${reg.tid}` === id,
          );

          if (!entry) {
            logger.warn(`Custom entry ${id} not found in response`);
            return;
          }

          if (!entry.v) {
            logger.warn(
              `Custom entry ${id} has no value. Got: ${JSON.stringify(entry)}`,
            );
          }

          entries.push({
            id,
            value: entry.v ? parseFloat(entry.v) : null,
          });
        });
      } catch (e) {
        failedBatches += 1;
        logger.error("Failed to fetch custom entries data:", e);
        logger.error(`Request '${url}' failed`);
        continue;
      }
    }

    if (failedBatches > 0) {
      logger.warn(
        `Custom entries polling completed with ${failedBatches} failed batch(es)`,
      );
    }

    return entries;
  }

  async fetchData(): Promise<ECoalResponse | null> {
    try {
      const batches = batcher(
        [
          "tzew_value",
          "fuel_level",
          "next_fuel_time",
          "ob1_pog_en",
          "tryb_auto_state",
          "tcwu_value",
          "tkot_value",
          "tpow_value",
          "tpod_value",
          "twew_value",
          "t1_value",
          "t2_value",
          "out_cwu",
          "tsp_value",
          "act_dm_speed",
          "kot_tzad",
          "out_pomp1",
          "out_cwutzad",
          "out_pomp2",
          "tzew_act",
          "kot_tact",
          "ob1_pok_tact",
          "ob1_pok_tzad",
          "ob1_zaw4d_tzad",
          "ob1_zaw4d_pos",
          "ob2_pok_tact",
          "ob2_pok_tzad",
          "cwu_tact",
          "ob3_pok_tact",
          "ob3_pok_tzad",
          "ob3_zaw4d_tzad",
          "ob3_zaw4d_pos",
          "pod_typ",
        ],
        3,
      );

      let mergeObject: Partial<ECoalResponse> = {};
      let failedBatches = 0;

      for await (const batch of batches) {
        const url = `http://${this.config.ecoal_host}/getregister.cgi?device=0&${batch.join("&")}`;

        try {
          const data = await this.fetchAndParseWithRetries<ECoalResponse>(
            url,
            "getregister.cgi/poll",
          );

          if (Array.isArray(data.cmd.device.reg)) {
            mergeObject = merge(mergeObject, data);
            continue;
          }

          mergeObject = merge(mergeObject, {
            cmd: { device: { reg: [data.cmd.device.reg] } },
          });
        } catch (e) {
          failedBatches += 1;
          logger.error("Failed to fetch eCoal data batch:", e);
          logger.error(`Request '${url}' failed`);
          continue;
        }
      }

      if (!mergeObject.cmd?.device?.reg) {
        logger.error("Failed to fetch eCoal data: all batches failed");
        return null;
      }

      if (failedBatches > 0) {
        logger.warn(
          `Polling completed with ${failedBatches} failed batch(es), publishing partial data`,
        );
      }

      if (this.config.raw_data_logging) {
        logger.info(
          `[RAW][getregister.cgi/poll_merged][PARSED]\n${JSON.stringify(mergeObject)}`,
        );
      }
      logger.debug("Fetched eCoal data successfully");
      return mergeObject as ECoalResponse;
    } catch (error) {
      logger.error("Failed to fetch eCoal data:", error);
      return null;
    }
  }

  async setValue(parameter: string, value: string | number): Promise<boolean> {
    try {
      const url = `http://${this.config.ecoal_host}/setregister.cgi?device=0&${parameter}=${value}`;

      const response = await legacyFetch(url, {
        user: this.config.ecoal_username,
        pass: this.config.ecoal_password,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      logger.info(`Successfully set ${parameter} to ${value}`);
      return true;
    } catch (error) {
      logger.error(`Failed to set ${parameter} to ${value}:`, error);
      return false;
    }
  }
}
