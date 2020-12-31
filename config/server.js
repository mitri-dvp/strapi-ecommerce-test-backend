module.exports = ({ env }) => {
  
  if(env('NODE_ENV') === 'production') {
    return {
      host: env('HOST'),
      port: env.int('PORT', 1337),
      url: env('HEROKU_URL'),
      admin: {
        auth: {
          secret: env('ADMIN_JWT_SECRET'),
        },
      },
    };
  }

  return {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 1337),
    admin: {
      auth: {
        secret: env('ADMIN_JWT_SECRET'),
      },
    },
  };

};
