import { parse, stringify } from 'querystring'
import { fetchJson } from '../../common/network'
import { IncompatibleVersionError } from '../../errors'
import config from './config'

const scope = 'operation-history account-info'

export function isAuthError (err) {
  return err && err.message === 'authorization error'
}

async function callGate (url, options = {}, predicate = () => true) {
  const response = await fetchJson(url, {
    method: 'POST',
    sanitizeRequestLog: { headers: { Authorization: true } },
    sanitizeResponseLog: { headers: { 'set-cookie': true } },
    ...options,
    stringify,
    headers: {
      Host: 'money.yandex.ru',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers
    }
  })
  if (predicate) {
    if (response.status === 401) {
      throw new TemporaryError('authorization error')
    }
  }
  return response
}

export async function login () {
  if (!ZenMoney.openWebView) {
    throw new IncompatibleVersionError()
  }
  const { error, code } = await new Promise((resolve) => {
    const redirectUriWithoutProtocol = config.redirectUri.replace(/^https?:\/\//i, '')
    const url = `https://money.yandex.ru/oauth/authorize?${stringify({
      client_id: config.clientId,
      scope,
      redirect_uri: config.redirectUri,
      response_type: 'code'
    })}`
    ZenMoney.openWebView(url, null, (request, callback) => {
      const i = request.url.indexOf(redirectUriWithoutProtocol)
      if (i < 0) {
        return
      }
      const params = parse(request.url.substring(i + redirectUriWithoutProtocol.length + 1))
      if (params.code) {
        callback(null, params.code)
      } else {
        callback(params)
      }
    }, (error, code) => resolve({ error, code }))
  })
  if (error && (!error.error || error.error === 'access_denied')) {
    throw new TemporaryError('Не удалось пройти авторизацию в Яндекс.Деньги. Попробуйте еще раз')
  }
  console.assert(code && !error, 'non-successfull authorization', error)
  const response = await callGate('https://money.yandex.ru/oauth/token', {
    body: {
      client_id: config.clientId,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code
    },
    sanitizeRequestLog: { body: true },
    sanitizeResponseLog: { body: { access_token: true }, headers: { 'set-cookie': true } }
  }, null)
  if (!response.body || !response.body.access_token) {
    throw new TemporaryError('Не удалось пройти авторизацию в Яндекс.Деньги. Попробуйте еще раз')
  }
  return { accessToken: response.body.access_token }
}

export async function fetchAccount ({ accessToken }) {
  const response = await callGate('https://money.yandex.ru/api/account-info', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  return response.body
}

export async function fetchTransactions ({ accessToken }, fromDate, toDate) {
  const transactions = []
  let nextRecord = null
  do {
    const response = await callGate('https://money.yandex.ru/api/operation-history', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: {
        from: fromDate.toISOString(),
        ...toDate && { till: toDate.toISOString() },
        ...nextRecord && { start_record: nextRecord }
      }
    })
    nextRecord = response.body.next_record
    transactions.push(...response.body.operations)
  } while (nextRecord)
  return transactions
}
