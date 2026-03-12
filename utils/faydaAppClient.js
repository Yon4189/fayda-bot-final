/**
 * faydaAppClient.js
 * 
 * Handles interaction with the Fayda Mobile App API (no captcha required).
 */

const axios = require('axios');
const logger = require('./logger');

const BASE_URL = 'https://fayda-app-backend.fayda.et/api/v2';

// The mobile app user agent and headers
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Connection': 'keep-alive',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Fayda/77 CFNetwork/3860.400.51 Darwin/25.3.0',
};

class FaydaAppClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('Fayda App API Key is required');
    }
    this.apiKey = apiKey;
    
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        ...DEFAULT_HEADERS,
        'x-api-key': this.apiKey
      },
      timeout: 15000 // 15 seconds timeout
    });
  }

  /**
   * Step 1: Send OTP to user's phone
   * 
   * @param {string} individualId - The user's ID number
   * @param {string} idType - Usually 'FIN' or 'FAN'
   * @returns {Promise<Object>} { transactionId }
   */
  async sendOtp(individualId, idType = 'FIN') {
    try {
      const payload = {
        individualId,
        individualIdType: idType
      };

      const response = await this.client.post('/otp/send-otp', payload);
      
      // Response format: { "message": "OTP sent successfully", "transactionId": "edefa417-..." }
      if (response.data && response.data.transactionId) {
        return {
          success: true,
          transactionId: response.data.transactionId,
          message: response.data.message
        };
      }
      
      throw new Error('Invalid response from send-otp: no transactionId');
    } catch (error) {
      this._handleApiError('sendOtp', error);
    }
  }

  /**
   * Step 2: Verify OTP and get user data + images
   * 
   * @param {string} otp - The 6-digit code
   * @param {string} transactionId - From sendOtp
   * @param {string} individualId - The user's ID number
   * @returns {Promise<Object>} { userData, images }
   */
  async verifyOtp(otp, transactionId, individualId) {
    try {
      const payload = {
        otp,
        transactionId,
        individualId
      };

      const response = await this.client.post('/otp/verify-otp', payload);
      
      const data = response.data;
      if (data && data.user && data.user.data) {
        // The API returns the user object which contains both text demographics
        // and base64 strings for the images (photo, QRCodes, fronts, backs).
        const user = data.user.data;
        
        return {
          success: true,
          userData: {
            fcn: user.fcn,
            UIN: user.UIN,
            phone: user.phone,
            dateOfBirth_eng: user.dateOfBirth_eng,
            dateOfBirth_et: user.dateOfBirth_et,
            gender_amh: user.gender_amh,
            gender_eng: user.gender_eng,
            citizenship_amh: user.citizenship_amh,
            citizenship_Eng: user.citizenship_Eng,
            region_amh: user.region_amh,
            region_eng: user.region_eng,
            zone_amh: user.zone_amh,
            zone_eng: user.zone_eng,
            woreda_amh: user.woreda_amh,
            woreda_eng: user.woreda_eng,
            fullName_amh: user.fullName_amh,
            fullName_eng: user.fullName_eng,
          },
          images: {
            photo: user.photo,
            qrCode: user.QRCodes,
            front: user.fronts,
            back: user.backs
          }
        };
      }
      
      throw new Error('Invalid response from verify-otp: no user data');
    } catch (error) {
      this._handleApiError('verifyOtp', error);
    }
  }

  _handleApiError(method, error) {
    let errMsg = error.message;
    if (error.response) {
      errMsg = `API Error [${error.response.status}]: ${JSON.stringify(error.response.data)}`;
    } else if (error.request) {
      errMsg = 'Network Error: No response received from Fayda API';
    }
    logger.error(`[FaydaAppClient.${method}] ${errMsg}`);
    throw new Error(errMsg);
  }
}

module.exports = FaydaAppClient;
