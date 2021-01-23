/* eslint-disable quotes */
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
const from_email = process.env.SENDGRID_DEFAULT_FROM; // should be in proccess.env (Sender)

const fromDecimalToInt = (n) => {
  return parseInt(n * 100);
};

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/controllers.html#core-controllers)
 * to customize this controller
 */

module.exports = {

  count(ctx) {
    const { user } = ctx.state;

    if (ctx.query._q) {
      return strapi.services.order.countSearch({...ctx.query, user: user.id});
    }
    return strapi.services.order.count({...ctx.query, user: user.id});
  },

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
    const { products, total } = ctx.request.body;
    const { provider } = ctx.request.query;
    const { user } = ctx.state;

    const BASE_URL = ctx.request.headers.origin || 'http://localhost:3000/';

    if(!products) {
      return ctx.throw(400, 'Plese specify products.');
    }

    const products_list = [];
    const products_list_ID = [];

    await new Promise((resolve, reject) => {
      products.forEach(async(product, i) => { 
        let tempProduct = {};
        const realProduct = await strapi.services.product.findOne({id: product.id});
        if(!realProduct) {
          reject();
        }

        products_list_ID.push(realProduct.id);

        tempProduct.id = realProduct.id;
        tempProduct.title = realProduct.title;
        tempProduct.price = realProduct.price;
        tempProduct.slug = realProduct.slug;
        tempProduct.image = {};
        tempProduct.image.url = realProduct.image.formats.thumbnail.url;
        tempProduct.cart_amount = products[i].cart_amount;

        products_list.push(tempProduct);

        if(i >= products.length - 1) resolve(true);
      });
    }).catch(() => {  
      ctx.throw(404, 'No product with such ID.');
    });



    // STRIPE
    if(provider === 'stripe') {
      const line_items = products_list.map(e => {
        const a = {
          price_data: {
            currency: 'usd',
            product_data: {
              name: e.title,
            },
            unit_amount: fromDecimalToInt(e.price)
          },
          quantity: e.cart_amount
        };
        return a;
      });

      console.log(line_items);

      // Create Stripe Chechkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        // customer_email: user.email,
        mode: 'payment',
        success_url: `${BASE_URL}/success/stripe?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: BASE_URL,
        line_items: line_items
      });

      // Create the Order
      const newOrder = await strapi.services.order.create({
        user: user.id,
        products_list: products_list,
        products: products_list_ID,
        total: total,
        status: 'unpaid',
        checkout_session: session.id,
        provider: provider,
      });

      return { id: session.id };
    }

    // PAYPAL
    if(provider === 'paypal') {
      const items = products_list.map(e => {
        const a = {
          name: e.title,
          price: e.price,
          currency: 'USD',
          quantity: e.cart_amount
        };
        return a;
      });
      
      const transactions = [{
        'item_list': {
          'items': items,
        },
        'amount': {
          'currency': 'USD',
          'total': total
        },
        'description': 'This is the payment transaction description.'
      }];

      const create_payment_json = {
        'intent': 'sale',
        'payer': {
          'payment_method': 'paypal'
        },
        'redirect_urls': {
          'return_url': `${BASE_URL}/success/paypal`,
          'cancel_url': BASE_URL
        },
        'transactions': transactions
      };
      
      const link = await new Promise((resolve, reject) => {
        paypal.payment.create(create_payment_json, (error, payment) => {
          if (error) {
            reject(ctx.throw(400, 'PayPal capture was not successful.'));
          } else {
            for(let i = 0;i < payment.links.length;i++){
              if(payment.links[i].rel === 'approval_url'){
                resolve(payment.links[i].href);
                return;
              }
            }
            reject();
          }
        });
      }).catch(() => {  
        ctx.throw(404, 'PayPal Approval Url Not Found.');
      });

      const token = new URL(link).searchParams.get('token');

      const newOrder = await strapi.services.order.create({
        user: user.id,
        products_list: products_list,
        products: products_list_ID,
        total: total,
        status: 'unpaid',
        checkout_session: token,
        provider: provider,
      });

      return {link, transactions};
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
          status: 'paid',
        });
        const updated_order = sanitizeEntity(updateOrder, { model: strapi.models.order });

        let list = '';
        updated_order.products_list.forEach(product => {
          list = list + `
          <div style="display: flex;justify-content: space-between;gap: 0.5rem;align-items: center;">
            <img style="width: 4rem;height: max-content;
            margin: 0;" src="${product.image.url}" alt="${product.title}_img">
            <p style="font-weight: bold; margin-right: auto;margin-left: 0.5rem;padding-right: 0.5rem;">${product.title} x ${product.cart_amount}</p>
            <p style="font-weight: bold; min-width: max-content;">$${(product.price * product.cart_amount).toFixed(2)}</p>
          </div>
          `;
        });

        await strapi.plugins['email'].services.email.send({
          to: updated_order.user.email,
          from: from_email,
          subject: 'Purchase Receipt',
          text: `Hola`,
          html: `<div style="max-width: 20rem;border-radius: 0.25rem;padding: 1.5rem;background: #ffffff;color: #333;box-shadow: 0 2px 3px 0px #00000010;border: 1px solid #00000020;padding-bottom: 0;">
            <div style="margin-bottom: 1.5rem;">
              <h2 style="margin-top: 0;text-align: center">Thank you for your purchase!</h2>
              <div style="display: flex;justify-content: space-between;">
                <h4 style="color: #888;margin: 0;">ORDER: ${updated_order.id}</h4>
                <h4 style="color: #888;margin: 0;margin-left: auto;">${new Date(updated_order.updated_at).toLocaleString('en-US')}</h4>
              </div>
            </div>
              <hr style="color: #00000020;">
            <div style="margin-top: 1.5rem;display: grid;gap: 0.5rem;">
              ${list}
              <hr style="color: #00000020;width: 100%;">
              <div style="display: flex;justify-content: space-between;gap: 0.5rem;align-items: center;padding-bottom: 0.5rem;">
                <p>&nbsp;</p>
                <p style="font-weight: bold; margin-left: auto; margin-right:0.5rem">Total:</p>
                <p style="font-weight: bold;"">$${updated_order.total}</p>
              </div>
            </div>
          </div>`,
        });
        
        return updated_order;
      } else {
        ctx.throw(400, 'The payment was not successful, please call support');
      }
    }
    
    // PAYPAL
    if(provider === 'paypal') {
      const { paymentId, token, PayerID, transactions } = ctx.request.body;
  
      const execute_payment_json = {
        'payer_id': PayerID,
        'transactions': transactions
      };

      const payment = await new Promise((resolve, reject) => {
        paypal.payment.execute(paymentId, execute_payment_json, (error, payment) => {
          if (error) {
            reject();
          } else {
            resolve(payment);
          }
        });
      }).catch(() => {  
        ctx.throw(404, 'PayPal Execute Was Not Successful.');
      });

      if(payment.state === 'approved') {
        const updateOrder = await strapi.services.order.update({
          checkout_session: token
        }, {
          status: 'paid'
        });
        const updated_order = sanitizeEntity(updateOrder, { model: strapi.models.order });
        return updated_order;
      } else {
        ctx.throw(400, 'The payment was not successful, please call support');
      }
    }
  },

  async contact(ctx) {
    const to_email = process.env.SENDGRID_REPLY_TO; // should be in proccess.env (Reciever)

    const { name, email, phone, order, message } = ctx.request.body;

    if(!name) return ctx.throw(404, 'Please enter all fields.');
    if(!email) return ctx.throw(404, 'Please enter all fields.');
    if(!phone) return ctx.throw(404, 'Please enter all fields.');
    if(!message) return ctx.throw(404, 'Please enter all fields.');

    if(order) {
      await strapi.plugins['email'].services.email.send({
        to: to_email,
        from: from_email,
        subject: 'Client Order Issue',
        text:`Message:\n${message}\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nOrder: ${order}`,
        html: `
        <div style="
        max-width: 20rem;
        border-radius: 0.25rem;
        padding: 1.5rem;
        background: #ffffff;
        color: #333;
        box-shadow: 0 2px 3px 0px #00000010;
        border: 1px solid #00000020;
        ">
          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin-top: 0;text-align: center;">Message:</h4>
            <p>
              ${message}
            </p>
          </div>
          <hr style="color: #00000020;">
          <div style="margin-top: 1.5rem;">
            <b>Name:</b>  ${name} <br/>
            <b>Email:</b> ${email} <br/>
            <b>Phone:</b> ${phone} <br/>
            <b>Order:</b> ${order}
          </div>
        </div>`
      });
      return {msg: 'Email sent...'};
    } else if(order === null) {
      await strapi.plugins['email'].services.email.send({
        to: to_email,
        from: from_email,
        subject: 'Client Question',
        text:`Message:\n${message}\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}`,
        html: `
        <div style="
        max-width: 20rem;
        border-radius: 0.25rem;
        padding: 1.5rem;
        background: #ffffff;
        color: #333;
        box-shadow: 0 2px 3px 0px #00000010;
        border: 1px solid #00000020;
        ">
          <div style="margin-bottom: 1.5rem;">
            <h4 style="margin-top: 0;text-align: center;">Message:</h4>
            <p>
              ${message}
            </p>
          </div>
          <hr style="color: #00000020;">
          <div style="margin-top: 1.5rem;">
            <b>Name:</b> ${name} <br/>
            <b>Email:</b> ${email} <br/>
            <b>Phone:</b> ${phone}
          </div>
        </div>`
      });
      return {msg: 'Email sent...'};
    } else {
      return ctx.throw(404, 'Please enter all fields.');
    }
  },
};
