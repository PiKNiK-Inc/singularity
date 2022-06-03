import BaseService from '../common/BaseService';
import { Category } from '../common/Logger';
import config from 'config';
import Datastore from '../common/Datastore';
import axios, { AxiosRequestHeaders } from 'axios';

export default class DealTrackingService extends BaseService {
  public constructor () {
    super(Category.DealTrackingService);
    this.startDealTracking = this.startDealTracking.bind(this);
  }

  public start (): void {
    if (!this.enabled) {
      this.logger.warn('Service is not enabled. Exit now...');
    }

    this.startDealTracking();
  }

  private async startDealTracking (): Promise<void> {
    await this.dealTracking();
    setTimeout(this.startDealTracking, 600_000);
  }

  private async dealTracking (): Promise<void> {
    this.logger.info('Start update deal tracking');
    const clientStates = await Datastore.DealTrackingStateModel.find({ stateType: 'client', stateValue: 'track' });
    for (const clientState of clientStates) {
      const client = clientState.stateKey;
      const lastDeal = await Datastore.DealStateModel.find({ client }).sort({ dealId: -1 }).limit(1);
      try {
        await this.insertDealFromFilscan(client, lastDeal.length > 0 ? lastDeal[0].dealId! : 0);
      } catch (error) {
        this.logger.error('Encountered an error when importing deals from filescan', error);
      }
      try {
        await this.updateDealFromLotus(client);
      } catch (error) {
        this.logger.error('Encountered an error when updating deals from lotus', error);
      }
    }
  }

  /**
   * Read from filscan api for PublishStorageDeal status
   *
   * @param client
   * @param lastDeal
   */
  private async insertDealFromFilscan (client: string, lastDeal: number): Promise<void> {
    this.logger.debug('updating deals from filscan', { client, lastDeal });
    let page = 0;
    let response;
    do {
      const offset = page * 25;
      let breakOuter = false;

      let url = 'https://api.filscan.io:8700/rpc/v1';
      if (client.startsWith('t')) {
        url = 'https://calibration.filscan.io:8700/rpc/v1';
      }
      this.logger.debug(`Fetching from ${url}`);
      response = await axios.post(url, {
        id: 1,
        jsonrpc: '2.0',
        params: [client, offset, 25],
        method: 'filscan.GetMarketDeal'
      }, {
        headers: {
          'content-type': 'application/json'
        }
      });
      if (Array.isArray(response.data['result']['deals'])) {
        const jsonResult = response.data['result'];
        this.logger.debug(`Received ${offset} out of ${jsonResult['total']} deal entries.`);
        for (const deal of jsonResult['deals']) {
          if (deal['dealid'] <= lastDeal || jsonResult['deals'].length < 25) {
            breakOuter = true;
            this.logger.info('Reached to the last page or last checked deal.');
            break;
          }
          const proposedDeal = await Datastore.DealStateModel.findOne({
            pieceCid: deal['piece_cid'],
            provider: deal['provider'],
            client: deal['client'],
            state: 'proposed'
          });

          if (proposedDeal) {
            await Datastore.DealStateModel.updateOne({
              _id: proposedDeal._id
            }, {
              $set: {
                dealId: deal['dealid'],
                state: 'published'
              }
            });
            this.logger.debug(`Deal ${deal['dealid']} was proposed through singularity. Filling in deal ID.`);
          } else {
            await Datastore.DealStateModel.updateOne({
              dealId: deal['dealid']
            }, {
              $setOnInsert: {
                client,
                provider: deal['provider'],
                dealId: deal['dealid'],
                dealCid: deal['cid'],
                pieceCid: deal['piece_cid'],
                expiration: deal['end_epoch'],
                duration: deal['end_epoch'] - deal['start_epoch'],
                state: 'published'
              }
            }, {
              upsert: true
            });
            this.logger.debug(`Deal ${deal['dealid']} updates to published.`);
          }
        }
        if (breakOuter) {
          break;
        }
      } else {
        this.logger.debug('No result from filscan');
        break;
      }
      page += 1;
    } while (response.data['result']['deals'].length > 0);
  }

  /**
   * @param client
   * @param lastDeal
   */
  /* Temporarily disabled in favor of filscan for more information
  private async insertDealFromFilfox(client: string, lastDeal: number): Promise<void> {
    this.logger.debug('Inserting new deals from filfox', { client, lastDeal });
    let page = 0;
    let response;
    do {
      let breakOuter = false;
      // Exponential retry as filfox can throttle us
      response = await retry(
        async () => {
          const url = `https://filfox.info/api/v1/deal/list?address=${client}&pageSize=100&page=${page}`;
          this.logger.debug(`Fetching from ${url}`);
          let r;
          try {
            r = await axios.get(url);
          } catch (e) {
            this.logger.warn(e);
            throw e;
          }
          return r;
        }, {
        retries: 3,
        minTimeout: 60_000
      }
      );
      this.logger.debug(`Received ${response.data['deals'].length} deal entries.`);
      for (const deal of response.data['deals']) {
        if (deal['id'] <= lastDeal) {
          breakOuter = true;
          break;
        }
        await Datastore.DealStateModel.updateOne({
          dealId: deal['id']
        }, {
          $setOnInsert: {
            client,
            provider: deal['provider'],
            dealId: deal['id'],
            state: 'published'
          }
        }, {
          upsert: true
        });
      }
      if (breakOuter) {
        break;
      }
      page += 1;
    } while (response.data['deals'].length > 0);
  }
  */

  private async updateDealFromLotus (client: string): Promise<void> {
    this.logger.debug('Start update deal state from lotus.', { client });
    const api = config.get<string>('deal_tracking_service.lotus_api');
    const token = config.get<string>('deal_tracking_service.lotus_token');
    for await (const dealState of Datastore.DealStateModel.find({
      client,
      state: 'published'
    })) {
      const headers: AxiosRequestHeaders = {};
      if (token !== '') {
        headers['Authorization'] = `Bearer ${token}`;
      }
      this.logger.debug(`Fetching from ${api}`, { dealId: dealState.dealId });
      const response = await axios.post(api, {
        id: 1,
        jsonrpc: '2.0',
        method: 'Filecoin.StateMarketStorageDeal',
        params: [dealState.dealId, null]
      }, { headers });
      if (response.data.error && response.data.error.code === 1) {
        await Datastore.DealStateModel.findByIdAndUpdate(dealState.id, {
          state: 'slashed'
        });
        return;
      }
      const result = response.data.result;
      const expiration: number = result.Proposal.EndEpoch;
      const slashed = result.State.SlashEpoch > 0;
      const pieceCid = result.Proposal.PieceCID['/'];
      const dealActive = result.State.SectorStartEpoch > 0;
      if (slashed) {
        await Datastore.DealStateModel.findByIdAndUpdate(dealState.id, {
          pieceCid, expiration, state: 'slashed'
        });
        this.logger.warn(`Deal ${dealState.dealId} is slashed.`);
      } else if (dealActive) {
        await Datastore.DealStateModel.findByIdAndUpdate(dealState.id, {
          pieceCid, expiration, state: 'active'
        });
        this.logger.info(`Deal ${dealState.dealId} is active on chain.`);
      }
    }
  }
}
