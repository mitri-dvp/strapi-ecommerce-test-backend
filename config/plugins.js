/* eslint-disable linebreak-style */
module.exports = ({ env }) => {

  if(env('NODE_ENV') === 'production') {
    return {
      upload: {
        provider: 'cloudinary',
        providerOptions: {
          cloud_name: env('CLOUDINARY_NAME'),
          api_key: env('CLOUDINARY_KEY'),
          api_secret: env('CLOUDINARY_SECRET'),
        },
      },
      email: {
        provider: 'sendgrid',
        providerOptions: {
          apiKey: env('SENDGRID_API_KEY'),
        },
        settings: {
          defaultFrom: env('SENDGRID_DEFAULT_FROM'),
          defaultReplyTo: env('SENDGRID_REPLY_TO'),
        },
      },
    };
  }

  return {
    email: {
      provider: 'sendgrid',
      providerOptions: {
        apiKey: env('SENDGRID_API_KEY'),
      },
      settings: {
        defaultFrom: 'mitri-dev@mitri-dev.xyz',
        defaultReplyTo: 'mitri.dvp@gmail.com',
      },
    }
  };
};