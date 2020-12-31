/* eslint-disable no-unused-vars */
'use strict';

const { sanitizeEntity } = require('strapi-utils');
const stripe = require('stripe')(process.env.STRIPE_SK);
const paypal = require('paypal-rest-sdk');
paypal.configure({
  'mode': 'sandbox', //sandbox or live
  'client_id': process.env.PAYPAL_CLIENT_ID,
  'client_secret': process.env.PAYPAL_CLIENT_SECRET
});

const fromDecimalToInt = (n) => {
  return parseInt(n * 100);
};

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/controllers.html#core-controllers)
 * to customize this controller
 */

module.exports = {

  async find(ctx) {
    const { user } = ctx.state;

    let entities;

    if(ctx.query._q) {
      entities = await strapi.services.order.search({...ctx.query, user: user.id});
    } else {
      entities = await strapi.services.order.find({...ctx.query, user: user.id});
    }

    return entities.map(entity => sanitizeEntity(entity, {model: strapi.models.order}));  
  },

  async findOne(ctx) {
    const { id } = ctx.params;
    const { user } = ctx.state;

    const entity = await strapi.services.order.findOne({ id, user: user.id});

    return sanitizeEntity(entity,  {model: strapi.models.order});
  },

  async create(ctx) {
    const { product } = ctx.request.body;
    const { provider } = ctx.request.query;
    const { user } = ctx.state;

    const BASE_URL = ctx.request.headers.origin || 'http://localhost:3000/';

    if(!product) {
      return ctx.throw(400, 'Plese specify a product.');
    }
    const realProduct = await strapi.services.product.findOne({id: product.id});
    if(!realProduct) {
      return ctx.throw(404, 'No product with such ID.');
    }

    // STRIPE
    if(provider === 'stripe') {
      // Create Stripe Chechkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: user.email,
        mode: 'payment',
        success_url: `${BASE_URL}/success/stripe?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: BASE_URL,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: realProduct.title,
              },
              unit_amount: fromDecimalToInt(realProduct.price)
            },
            quantity: 1
          }
        ]
      });

      // Create the Order
      const newOrder = await strapi.services.order.create({
        user: user.id,
        product: realProduct.id,
        total: realProduct.price,
        status: 'unpaid',
        checkout_session: session.id,
      });

      return { id: session.id };
    }

    // PAYPAL
    if(provider === 'paypal') {
      const create_payment_json = {
        'intent': 'sale',
        'payer': {
          'payment_method': 'paypal'
        },
        'redirect_urls': {
          'return_url': `${BASE_URL}/success/paypal`,
          'cancel_url': BASE_URL
        },
        'transactions': [{
          'item_list': {
            'items': [{
              'name': realProduct.title,
              'price': realProduct.price,
              'currency': 'USD',
              'quantity': 1
            }]
          },
          'amount': {
            'currency': 'USD',
            'total': realProduct.price
          },
          'description': realProduct.description
        }]
      };
      
      const link = await new Promise((resolve, reject) => {
        paypal.payment.create(create_payment_json, (error, payment) => {
          if (error) {
            reject(ctx.throw(400, 'PayPal capture was not successful.'));
          } else {
            for(let i = 0;i < payment.links.length;i++){
              if(payment.links[i].rel === 'approval_url'){
                resolve(payment.links[i].href);
              }
            }
            reject('Not found');
          }
        });
      });

      const token = new URL(link).searchParams.get('token');

      const newOrder = await strapi.services.order.create({
        user: user.id,
        product: realProduct.id,
        total: realProduct.price,
        status: 'unpaid',
        checkout_session: token,
      });

      return link;
    }
  },

  async confirm(ctx) {
    const { provider } = ctx.request.query;
    
    // STRIPE
    if(provider === 'stripe') {
      const { checkout_session } = ctx.request.body;
      const session = await stripe.checkout.sessions.retrieve(checkout_session);

      if(session.payment_status === 'paid') {
        const updateOrder = await strapi.services.order.update({
          checkout_session
        }, {
          status: 'paid'
        });

        return sanitizeEntity(updateOrder, { model: strapi.models.order });
      } else {
        ctx.throw(400, 'The payment was not successful, please call support');
      }
    }
    
    // PAYPAL
    if(provider === 'paypal') {
      const { paymentId, token, PayerID } = ctx.request.body;

      const order = await strapi.services.order.findOne({checkout_session: token});
      const product = order.product;

      const execute_payment_json = {
        'payer_id': PayerID,
        'transactions': [{
          'item_list': {
            'items': [{
              'name': product.title,
              'price': product.price,
              'currency': 'USD',
              'quantity': 1
            }]
          },
          'amount': {
            'currency': 'USD',
            'total': product.price
          },
          'description': product.description
        }]
      };

      const payment = await new Promise((resolve, reject) => {
        paypal.payment.execute(paymentId, execute_payment_json, (error, payment) => {
          if (error) {
            reject(ctx.throw(400, 'PayPal execute was not successful.'));
          } else {
            resolve(payment);
          }
        });
      });

      if(payment.state === 'approved') {
        const updateOrder = await strapi.services.order.update({
          checkout_session: token
        }, {
          status: 'paid'
        });

        return sanitizeEntity(updateOrder, { model: strapi.models.order });
      } else {
        ctx.throw(400, 'The payment was not successful, please call support');
      }
    }
  }

};
