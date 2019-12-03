import assert from 'assert'
import moment from 'moment-timezone'
import TelegramBot, { Message, User } from 'node-telegram-bot-api'

import Logger from 'helpers/Logger'
import { logUnhandledErrors, onShutdown } from 'helpers'
import { dfusionService } from 'services'
import { formatAmount, formatAmountFull } from 'utils/format'
import BN from 'bn.js'
import { FEE_DENOMINATOR } from 'const'

const WEB_BASE_URL = process.env.WEB_BASE_URL
assert(WEB_BASE_URL, 'WEB_BASE_URL is required')

// To fill an order, no solver will match the trades if there's not 2*FEE spread between the trades
const FACTOR_TO_FILL_ORDER = 1 + 2 / FEE_DENOMINATOR

moment.tz.setDefault('Etc/GMT')

logUnhandledErrors()

const log = new Logger('bot')
const token = process.env.TELEGRAM_TOKEN as string
const channelId = process.env.TELEGRAM_CHANNEL_ID as string

assert(token, 'TELEGRAM_TOKEN env var is required')
assert(channelId, 'TELEGRAM_CHANNEL_ID env var is required')

// Private channels are identified by numbers
const isPublicChannel = isNaN(channelId as any)
const channelHandle = isPublicChannel ? channelId : '**private chat**'

const bot = new TelegramBot(token, {
  polling: true
})

bot.onText(/\/(\w+) ?(.+)?/, (msg: Message, match: RegExpExecArray | null) => {
  log.debug('New command: %o', msg)

  _runCommand(msg, match).catch(error => {
    log.error('Error running command for message: %o', msg)
    log.error(error)
  })
})

// Listen to any message
bot.on('message', (msg: Message) => {
  const isCommand = msg.text && msg.text.startsWith('/')
  if (!isCommand) {
    log.debug('Received msg: %o', msg)
    _helpCommand(msg)
  }
})

onShutdown(() => {
  log.info('Bye!')
})

async function _runCommand (msg: Message, match: RegExpExecArray | null) {
  const command = match ? match[1] : ''
  switch (command) {
    case 'start':
    case 'help':
      await _helpCommand(msg)
      break

    case 'about':
      await _aboutCommand(msg)
      break

    default:
      await bot.sendMessage(msg.chat.id, "I don't recognize that command! You can use this other one instead: /help")
  }
}
async function _helpCommand (msg: Message) {
  const fromUser: User | undefined = msg.from
  bot.sendMessage(
    msg.chat.id,
    `${fromUser ? 'Hi ' + fromUser.first_name : 'Hi there'}!
    
I don't talk much for now. I just notify every new order in dFusion channel.
Please, go to ${channelHandle} to get notified on every new order.

Also, you can ask about me by using the command: /about`
  )
}

async function _aboutCommand (msg: Message) {
  const { blockNumber, networkId, nodeInfo, version, stablecoinConverterAddress } = await dfusionService.getAbout()

  bot.sendMessage(
    msg.chat.id,
    `I'm just a bot watching dFusion smart contract.

If you want to know more about me, checkout my code in https://github.com/gnosis/dex-telegram

In that github you'll be able to fork me, open issues, or even better, give me some additional functionality (Pull Requests are really welcomed 😀).

Some interesting facts are:
- Bot version: ${version}
- Contract Address: ${stablecoinConverterAddress}
- Ethereum Network: ${networkId}
- Ethereum Node: ${nodeInfo}
- Last minded block: ${blockNumber}

Also, here are some links you might find useful:
- https://github.com/gnosis/dex-contracts: dFusion Smart Contracts
- https://github.com/gnosis/dex-research: dFusion Research
- https://github.com/gnosis/dex-services: dFusion services`
  )
}

dfusionService.watchOrderPlacement({
  onNewOrder (order) {
    const {
      // owner,
      buyToken,
      sellToken,
      validFrom,
      validUntil,
      // validFromBatchId,
      // validUntilBatchId,
      priceNumerator,
      priceDenominator
      // event
    } = order

    // Calculate the price
    let price
    if (buyToken.decimals >= sellToken.decimals) {
      const precisionFactor = 10 ** (buyToken.decimals - sellToken.decimals)
      price = priceNumerator.dividedBy(priceDenominator.multipliedBy(precisionFactor))
    } else {
      const precisionFactor = 10 ** (sellToken.decimals - buyToken.decimals)
      price = priceNumerator.multipliedBy(precisionFactor).dividedBy(priceDenominator)
    }

    // Label for token
    // TODO: to use the shared utils function when available safeTokenName
    const sellTokenLabel = sellToken.symbol || sellToken.name || sellToken.address
    const buyTokenLabel = buyToken.symbol || buyToken.name || buyToken.address

    // Only display the valid from if the period hasn't started
    const now = new Date()
    let datesDescription = ''
    if (validFrom > now) {
      // The order is not active yet
      datesDescription = `  - *Tradable*: \`${moment(validFrom).calendar()} GMT\`, \`${moment(validFrom).fromNow()}\`\n`
    }
    datesDescription += `  - *Expires*: \`${moment(validUntil).calendar()} GMT\`, \`${moment(validUntil).fromNow()}\``

    // Format the amounts
    // TODO: Allow to use BN, string or BigNumber or all three in the format. Review in dex-js
    const sellAmountFmt = formatAmount(new BN(priceDenominator.toString()), sellToken.decimals)
    const buyAmountFmt = formatAmount(new BN(priceNumerator.toString()), buyToken.decimals)
    const fillSellAmountFmt = formatAmountFull(
      new BN(priceNumerator.multipliedBy(FACTOR_TO_FILL_ORDER).toString()),
      buyToken.decimals
    )
    const buyAmountFullFmt = formatAmountFull(new BN(priceDenominator.toString()), sellToken.decimals)

    // Compose message using markdown
    // TODO: Provide the link to the front end: https://github.com/gnosis/dex-telegram/issues/3
    // TODO: Should we publish even if the user doesn't have balance. Should we include the balance of the user? he can change it...
    const message = `Sell *${sellAmountFmt}* \`${sellTokenLabel}\` for *${buyAmountFmt}* \`${buyTokenLabel}\`

  - *Price*:  1 \`${sellTokenLabel}\` = ${price} \`${buyTokenLabel}\`
${datesDescription}

Fill the order here: ${WEB_BASE_URL}/trade/${buyTokenLabel}-${sellTokenLabel}?sell=${fillSellAmountFmt}&buy=${buyAmountFullFmt}` // TODO:

    // Send message
    bot.sendMessage(channelId, message, { parse_mode: 'Markdown' })
  },
  onError (error: Error) {
    log.error('Error watching order placements: ', error)
  }
})

onShutdown(() => {
  log.info('Stopping bot v%s. Bye!', dfusionService.getVersion())
})

log.info('The bot v%s is up :)', dfusionService.getVersion())
dfusionService
  .getAbout()
  .then(({ stablecoinConverterAddress, nodeInfo, networkId, blockNumber }) => {
    log.info(
      `'Using contract ${stablecoinConverterAddress} in network ${networkId} (${nodeInfo}). Last block: ${blockNumber}'`
    )
  })
  .catch(log.errorHandler)
