/* eslint-disable no-unreachable */
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
    const products_oos = [];

    // Product Validation/OOS Start
    await (async function loop() {
      for (let i = 0; i < products.length; i++) {
        await strapi.services.product.findOne({id:  products[i].id}).then((realProduct) => {
          let tempProduct = {};
          products_list_ID.push(realProduct.id);

          tempProduct.id = realProduct.id;
          tempProduct.title = realProduct.title;
          tempProduct.price = realProduct.price;
          tempProduct.slug = realProduct.slug;
          tempProduct.image = {};
          tempProduct.image.url = realProduct.image.formats.thumbnail.url;
          tempProduct.cart_amount = products[i].cart_amount;

          if(products[i].cart_amount > realProduct.amount) {
            products_oos.push({id: products[i].id, amount: realProduct.amount});
          }
    
          products_list.push(tempProduct);
        }).catch(() => {
          ctx.throw(404, 'No product with such ID.');
        });
      }
    })();

    if(products_oos.length > 0) return ({
      statusCode: 400,
      error: "Bad Request",
      message: "Products out of stock.",
      products: products_oos
    });
    if(products.length != products_list.length) return ctx.throw(500, 'Writing Error');
    // Validation Ends

    // STRIPE
    if(provider === 'stripe') {
      const line_items = products_list.map(e => {
        const a = {
          price_data: {
            currency: 'usd',
            product_data: {
              name: e.title,
              // images: [e.image.url],
              images: ['https://res.cloudinary.com/dz5vyxfew/image/upload/v1609450711/RFB_0502_1_pastelitoszulianos_529e1a5266.jpg'],
            },
            unit_amount: fromDecimalToInt(e.price)
          },
          quantity: e.cart_amount
        };
        return a;
      });

      // Create Stripe Chechkout Session - Payment Mode
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: user.email,
        mode: 'payment',
        success_url: `${BASE_URL}/success/stripe?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: BASE_URL,
        payment_intent_data: {capture_method: 'manual'},
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
        payment_ID: '',
        provider: provider,
      });

      return { id: session.id, products_list};
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
        payment_ID: '',
        provider: provider,
      });

      return {link, transactions, products_list};
    }
  },

  async confirm(ctx) {
    const { provider } = ctx.request.query;
    
    // STRIPE
    if(provider === 'stripe') {
      const { checkout_session, products_list } = ctx.request.body;
      let session;
      let intent;

      // Checkout Session Verification
      try {
        session = await stripe.checkout.sessions.retrieve(checkout_session);
      } catch (error) {
        return ({
          statusCode: 400,
          error: "Bad Request",
          message: "Must provide a Session."
        });  
      }

      if(session.payment_status === 'paid') {
        return ({
          statusCode: 304,
          message: "Payment has already been captured.",
        });
      }

      // Product Validation/Stock/Removal Transaction Start
      let error;
      const products_oos = [];
      const knex = strapi.connections.default;

      try {
        await knex.transaction(async trx => {
          const realProducts = await trx
            .select('amount', 'title')
            .from('products')
            .orderBy('id', 'asc');
        
          const res = await (async function loop() {
            for (let i = 0; i < products_list.length; i++) {
              const {id, cart_amount} = products_list[i];
              if(isNaN(id) || isNaN(cart_amount)) {
                error = 'NaN';
                await trx.rollback();
                return;
              }

              if(cart_amount > realProducts[id - 1].amount) {
                products_oos.push({
                  title: realProducts[id - 1].title
                });
              }

              const updatedProduct = await trx
                .where('id', '=', id)
                .update({
                  amount: realProducts[id - 1].amount - cart_amount,
                })
                .from('products');            
            }
          })();

          if(products_oos.length > 0) {
            error = 'oos';
            await trx.rollback();
            return;
          }
          return res;    
        });
      } catch (err) {

        if(error === 'oos') {
          intent = await stripe.paymentIntents.cancel(session.payment_intent);
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Products out of stock.",
            products: products_oos
          });
        }
        if(error === 'NaN') {
          intent = await stripe.paymentIntents.cancel(session.payment_intent);
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Not a Number."
          });
        } 
      }
      // Validation Ends

      try {
        intent = await stripe.paymentIntents.capture(session.payment_intent);
      } catch (err) {
        try {
          await knex.transaction(async trx => {
            const realProducts = await trx
              .select('amount', 'title')
              .from('products')
              .orderBy('id', 'asc');
            const res = await (async function loop() {
              for (let i = 0; i < products_list.length; i++) {
                const {id, cart_amount} = products_list[i];
                const updatedProduct = await trx
                  .where('id', '=', id)
                  .update({
                    amount: realProducts[id - 1].amount + cart_amount,
                  })
                  .from('products');            
              }
            })();
            return res;    
          });
        } catch (err) {
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Inventory Removal Failed."
          });
        }
        intent = await stripe.paymentIntents.cancel(session.payment_intent);
        return ({
          statusCode: 400,
          error: "Bad Request",
          message: "Stripe Intent must be a String."
        });
      }


      if(intent.status === 'succeeded') {

        const updateOrder = await strapi.services.order.update({
          checkout_session
        }, {
          status: 'paid',
          payment_ID: session.payment_intent
        });
        const updated_order = sanitizeEntity(updateOrder, { model: strapi.models.order });

        let list = '';
        updated_order.products_list.forEach(product => {
          list = list + `
          <div style="display: flex;justify-content: space-between;gap: 0.5rem;align-items: center;">
            <img style="width: 4rem;margin: 0;" src="${product.image.url}" alt="${product.title}_img">
            <p style="font-weight: bold; margin-right: auto;margin-left: 0.5rem;padding-right: 0.5rem;">${product.title} x ${product.cart_amount}</p>
            <p style="font-weight: bold; min-width: max-content;">$${(product.price * product.cart_amount).toFixed(2)}</p>
          </div>
          `;
        });

        // sendEmail(
        //   updated_order.user.email,
        //   from_email,
        //   updated_order.id,
        //   new Date(updated_order.updated_at).toLocaleString('en-US'),
        //   list,
        //   updated_order.total
        // );
        
        return ({
          statusCode: 200,
          message: "Success.",
          updated_order: updated_order
        });
      } else {
        // Undo Inventory Removal
        try {
          await knex.transaction(async trx => {
            const realProducts = await trx
              .select('amount', 'title')
              .from('products')
              .orderBy('id', 'asc');
          
            const res = await (async function loop() {
              for (let i = 0; i < products_list.length; i++) {
                const {id, cart_amount} = products_list[i];
                if(isNaN(id) || isNaN(cart_amount)) {
                  error = 'NaN';
                  await trx.rollback();
                  return;
                }
  
                const updatedProduct = await trx
                  .where('id', '=', id)
                  .update({
                    amount: realProducts[id - 1].amount + cart_amount,
                  })
                  .from('products');            
              }
            })();
            return res;    
          });
        } catch (err) {
          intent = await stripe.paymentIntents.cancel(session.payment_intent);
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Inventory Removal Failed."
          });
        }
        // Undo Inventory Removal Ends
        ctx.throw(400, 'The payment was not successful, please call support');
      }
    }
    
    // PAYPAL
    if(provider === 'paypal') {
      const { paymentId, token, PayerID, transactions, products_list } = ctx.request.body;
  
      const execute_payment_json = {
        'payer_id': PayerID,
        'transactions': transactions
      };

      const status = await new Promise((resolve, reject) => {
        paypal.payment.get(paymentId, (error, payment) => {
          if (error) {
            reject();
          } else {
            resolve(payment);
          }
        });
      }).catch(() => {  
        ctx.throw(404, 'PayPal Session Does Not Exists.');
      });

      if(status.state === 'approved') {
        return ({
          statusCode: 304,
          message: "Payment has already been captured.",
        });
      }


      // Product Validation/Stock/Removal Transaction Start
      let error;
      const products_oos = [];
      const knex = strapi.connections.default;
 
      try {
        await knex.transaction(async trx => {
          const realProducts = await trx
            .select('amount', 'title')
            .from('products')
            .orderBy('id', 'asc');
         
          const res = await (async function loop() {
            for (let i = 0; i < products_list.length; i++) {
              const {id, cart_amount} = products_list[i];
              if(isNaN(id) || isNaN(cart_amount)) {
                error = 'NaN';
                await trx.rollback();
                return;
              }
 
              if(cart_amount > realProducts[id - 1].amount) {
                products_oos.push({
                  title: realProducts[id - 1].title
                });
              }
 
              const updatedProduct = await trx
                .where('id', '=', id)
                .update({
                  amount: realProducts[id - 1].amount - cart_amount,
                })
                .from('products');            
            }
          })();
 
          if(products_oos.length > 0) {
            error = 'oos';
            await trx.rollback();
            return;
          }
          return res;    
        });
      } catch (err) {
 
        if(error === 'oos') {
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Products out of stock.",
            products: products_oos
          });
        }
        if(error === 'NaN') {
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Not a Number."
          });
        } 
      }
      // Validation Ends

      const payment = await new Promise((resolve, reject) => {
        paypal.payment.execute(paymentId, execute_payment_json, (error, payment) => {
          if (error) {
            reject();
          } else {
            resolve(payment);
          }
        });
      }).catch(async () => {  
        try {
          await knex.transaction(async trx => {
            const realProducts = await trx
              .select('amount', 'title')
              .from('products')
              .orderBy('id', 'asc');
            const res = await (async function loop() {
              for (let i = 0; i < products_list.length; i++) {
                const {id, cart_amount} = products_list[i];
                const updatedProduct = await trx
                  .where('id', '=', id)
                  .update({
                    amount: realProducts[id - 1].amount + cart_amount,
                  })
                  .from('products');            
              }
            })();
            return res;    
          });
        } catch (err) {
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Inventory Removal Failed."
          });
        }
        return ({
          statusCode: 400,
          error: "Bad Request",
          message: "Stripe Execute was not Succesful."
        });
      });

      if(payment.state === 'approved') {
        const updateOrder = await strapi.services.order.update({
          checkout_session: token
        }, {
          status: 'paid',
          payment_ID: '',
        });
        const updated_order = sanitizeEntity(updateOrder, { model: strapi.models.order });
        return ({
          statusCode: 200,
          message: "Success.",
          updated_order: updated_order
        });
      } else {
        // Undo Inventory Removal
        try {
          await knex.transaction(async trx => {
            const realProducts = await trx
              .select('amount', 'title')
              .from('products')
              .orderBy('id', 'asc');
          
            const res = await (async function loop() {
              for (let i = 0; i < products_list.length; i++) {
                const {id, cart_amount} = products_list[i];
                if(isNaN(id) || isNaN(cart_amount)) {
                  error = 'NaN';
                  await trx.rollback();
                  return;
                }
  
                const updatedProduct = await trx
                  .where('id', '=', id)
                  .update({
                    amount: realProducts[id - 1].amount + cart_amount,
                  })
                  .from('products');            
              }
            })();
            return res;    
          });
        } catch (err) {
          // Cancel
          return ({
            statusCode: 400,
            error: "Bad Request",
            message: "Inventory Removal Failed."
          });
        }
        // Undo Inventory Removal Ends
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

async function sendEmail(to, from, order_id, order_date, list, total) {
  await strapi.plugins['email'].services.email.send({
    to: to,
    from: from,
    subject: 'Purchase Receipt',
    text: `Hola`,
    html: `<div style="max-width: 20rem;border-radius: 0.25rem;padding: 1.5rem;background: #ffffff;color: #333;box-shadow: 0 2px 3px 0px #00000010;border: 1px solid #00000020;padding-bottom: 0;">
      <div style="margin-bottom: 1.5rem;">
        <h2 style="margin-top: 0;text-align: center">Thank you for your purchase!</h2>
        <div style="display: flex;justify-content: space-between;">
          <h4 style="color: #888;margin: 0;">ORDER: ${order_id}</h4>
          <h4 style="color: #888;margin: 0;margin-left: auto;">${order_date}</h4>
        </div>
      </div>
        <hr style="color: #00000020;">
      <div style="margin-top: 1.5rem;display: grid;gap: 0.5rem;">
        ${list}
        <hr style="color: #00000020;width: 100%;">
        <div style="display: flex;justify-content: space-between;gap: 0.5rem;align-items: center;padding-bottom: 0.5rem;">
          <p>&nbsp;</p>
          <p style="font-weight: bold; margin-left: auto; margin-right:0.5rem">Total:</p>
          <p style="font-weight: bold;"">$${total}</p>
        </div>
      </div>
    </div>`,
  });
}